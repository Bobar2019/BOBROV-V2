"""Flux vidéo MJPEG — Cam 1 et Cam 2 indépendantes (étape 6).

Capture V4L2 en **Python pur** (aucune dépendance externe) : la plupart des
webcams USB délivrent du MJPEG déjà compressé — on le relaie tel quel dans un
flux ``multipart/x-mixed-replace``, zéro ré-encodage, CPU quasi nul.

Architecture :
- ``V4L2Camera``  : accès bas niveau (ioctls + mmap) à un ``/dev/videoN``.
- ``CameraSource``: une caméra = un thread superviseur (reconnexion infinie),
  les dernières frames partagées entre tous les clients HTTP, arrêt automatique
  de la capture quand plus personne ne regarde (libère le bus USB).
- ``VideoManager``: singleton ``VIDEO`` gérant cam1 + cam2 (cycle de vie lié à
  l'application FastAPI) — ``get_video()`` pour l'accès global.
- ``router``      : endpoints ``/api/video/*`` (flux, état, devices, reload).

Offsets et codes ioctl validés contre les en-têtes du noyau local
(aarch64, kernel 6.18 — ``struct v4l2_format`` 208 octets, ``v4l2_buffer`` 88).
Aucune ligne de ce module ne doit faire échouer le serveur : caméra absente,
occupée ou débranchée en marche ⇒ état d'erreur journalisé, thread toujours
vivant, reconnexion automatique.
"""
from __future__ import annotations

import asyncio
import errno
import fcntl
import glob
import logging
import mmap
import os
import select
import struct
import threading
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse

from app.config import get_config

log = logging.getLogger("bobrov.video")

# ---------------------------------------------------------------------------
# Constantes V4L2 (vidéo capture UVC — valeurs sondées sur le noyau local)
# ---------------------------------------------------------------------------

V4L2_BUF_TYPE_VIDEO_CAPTURE = 1
V4L2_MEMORY_MMAP = 1
V4L2_FIELD_NONE = 1
V4L2_PIX_FMT_MJPEG = 0x47504A4D  # 'MJPG'
V4L2_CAP_VIDEO_CAPTURE = 0x00000001
V4L2_CAP_STREAMING = 0x04000000
V4L2_FRMSIZE_TYPE_DISCRETE = 1
V4L2_FRMIVAL_TYPE_DISCRETE = 1

VIDIOC_QUERYCAP = 0x80685600
VIDIOC_G_FMT = 0xC0D05604
VIDIOC_S_FMT = 0xC0D05605
VIDIOC_REQBUFS = 0xC0145608
VIDIOC_QUERYBUF = 0xC0585609
VIDIOC_QBUF = 0xC058560F
VIDIOC_DQBUF = 0xC0585611
VIDIOC_STREAMON = 0x40045612
VIDIOC_STREAMOFF = 0x40045613
VIDIOC_S_PARM = 0xC0CC5616
VIDIOC_ENUM_FMT = 0xC0405602
VIDIOC_ENUM_FRAMESIZES = 0xC02C564A
VIDIOC_ENUM_FRAMEINTERVALS = 0xC034564B

# Layouts (taille + offsets) des structures — validés par sonde C sur le noyau local.
FMT_SIZE, FMT_PIX = 208, 8                       # v4l2_format { type; union }
FMT_W, FMT_H, FMT_PXF, FMT_FIELD, FMT_SIZIMAGE = 8, 12, 16, 20, 28
BUF_SIZE, BUF_INDEX, BUF_USED, BUF_FLAGS = 88, 0, 8, 12
BUF_SEQ, BUF_MOFFSET, BUF_LENGTH = 56, 64, 72
REQB_SIZE, REQB_COUNT = 20, 0
PARM_SIZE, PARM_NUM, PARM_DEN = 204, 12, 16
FMTD_SIZE, FMTD_INDEX, FMTD_DESC, FMTD_PXF = 64, 0, 12, 44
FRMS_SIZE, FRMS_TYPE, FRMS_W, FRMS_H = 44, 8, 12, 16
FRMI_SIZE, FRMI_TYPE, FRMI_NUM, FRMI_DEN = 52, 16, 20, 24

_CAPTURE_BUFFERS = 4          # tampons mmap demandés au pilote
_STALL_TIMEOUT_S = 5.0        # sans image : fin du flux HTTP (le client reprend)
_FRAME_WAIT_TIMEOUT_S = 2.5   # sonde de frame : attente max d'une première image
_RECONNECT_DELAY_S = 2.0      # délai avant réouverture d'une caméra en erreur
_IDLE_STOP_S = 8.0            # capture arrêtée après ce délai sans client
_MJPEG_BOUNDARY = "bobrovframe"


class V4L2Error(RuntimeError):
    """Erreur d'accès à un périphérique V4L2 (ouverture, ioctl, flux interrompu)."""


def _u32(buf, offset: int) -> int:
    return struct.unpack_from("<I", buf, offset)[0]


# ---------------------------------------------------------------------------
# Accès bas niveau V4L2 (ioctls + mmap)
# ---------------------------------------------------------------------------

class V4L2Camera:
    """Périphérique V4L2 ouvert en MJPEG streaming (buffers mmap, 4 tampons)."""

    def __init__(self, device: str, width: int, height: int, fps: float):
        self.device = device
        self.width = width
        self.height = height
        self.fps = fps
        self.card = ""
        self.streaming = False
        self._fd = -1
        self._buffers: list[tuple[mmap.mmap, int]] = []

    # -- Ouverture / configuration -------------------------------------------

    def open(self) -> None:
        """Ouvre le périphérique, négocie MJPEG w×h et démarre le streaming."""
        try:
            self._fd = os.open(self.device, os.O_RDWR | os.O_NONBLOCK)
        except OSError as exc:
            raise V4L2Error(f"ouverture de {self.device} impossible : {exc.strerror or exc}") from exc
        try:
            self._query_cap()
            self._set_format()
            self._set_framerate()
            self._request_buffers()
            self._map_buffers()
            self._queue_all()
            self._ioctl(VIDIOC_STREAMON, struct.pack("<I", V4L2_BUF_TYPE_VIDEO_CAPTURE))
            self.streaming = True
        except V4L2Error:
            self.close()
            raise

    def _ioctl(self, request: int, arg) -> None:
        """ioctl avec code retour vérifié (erreur errno explicite)."""
        try:
            fcntl.ioctl(self._fd, request, arg)
        except OSError as exc:
            raise V4L2Error(f"ioctl 0x{request:08x} sur {self.device} : {exc.strerror or exc}") from exc

    def _query_cap(self) -> None:
        caps = bytearray(104)
        self._ioctl(VIDIOC_QUERYCAP, caps)
        # capabilities@84 (périphérique entier), device_caps@88 (ce nœud précis) :
        # c'est device_caps qui distingue capture vidéo / metadata / codec.
        capabilities = _u32(caps, 88) or _u32(caps, 84)
        if not capabilities & V4L2_CAP_VIDEO_CAPTURE:
            raise V4L2Error(f"{self.device} n'est pas un périphérique de capture vidéo")
        if not capabilities & V4L2_CAP_STREAMING:
            raise V4L2Error(f"{self.device} ne supporte pas le streaming (mmap)")
        self.card = bytes(caps[16:48]).split(b"\x00")[0].decode("utf-8", "replace").strip()

    def _set_format(self) -> None:
        """Négocie MJPG à la résolution demandée ; relit la valeur réellement retenue."""
        buf = bytearray(FMT_SIZE)
        struct.pack_into("<I", buf, 0, V4L2_BUF_TYPE_VIDEO_CAPTURE)
        struct.pack_into("<I", buf, FMT_W, self.width)
        struct.pack_into("<I", buf, FMT_H, self.height)
        struct.pack_into("<I", buf, FMT_PXF, V4L2_PIX_FMT_MJPEG)
        struct.pack_into("<I", buf, FMT_FIELD, V4L2_FIELD_NONE)
        self._ioctl(VIDIOC_S_FMT, buf)
        if _u32(buf, FMT_PXF) != V4L2_PIX_FMT_MJPEG:
            fourcc = struct.pack("<I", _u32(buf, FMT_PXF)).decode("ascii", "replace")
            raise V4L2Error(f"{self.device} : MJPEG refusé par la caméra (format imposé : {fourcc})")
        real_w, real_h = _u32(buf, FMT_W), _u32(buf, FMT_H)
        if (real_w, real_h) != (self.width, self.height):
            log.warning("[%s] résolution %dx%d non supportée — imposée par la caméra : %dx%d",
                        self.device, self.width, self.height, real_w, real_h)
            self.width, self.height = real_w, real_h

    def _set_framerate(self) -> None:
        """Cadence via VIDIOC_S_PARM (1/fps) — non bloquant si refusée par le pilote."""
        buf = bytearray(PARM_SIZE)
        struct.pack_into("<I", buf, 0, V4L2_BUF_TYPE_VIDEO_CAPTURE)
        struct.pack_into("<I", buf, PARM_NUM, 1)
        struct.pack_into("<I", buf, PARM_DEN, int(round(self.fps)))
        try:
            fcntl.ioctl(self._fd, VIDIOC_S_PARM, buf)
        except OSError as exc:
            log.warning("[%s] cadence %g fps non appliquée (%s) — cadence caméra par défaut",
                        self.device, self.fps, exc.strerror or exc)

    def _request_buffers(self) -> None:
        buf = bytearray(REQB_SIZE)
        struct.pack_into("<I", buf, REQB_COUNT, _CAPTURE_BUFFERS)
        struct.pack_into("<I", buf, 4, V4L2_BUF_TYPE_VIDEO_CAPTURE)
        struct.pack_into("<I", buf, 8, V4L2_MEMORY_MMAP)
        self._ioctl(VIDIOC_REQBUFS, buf)
        self._buffer_count = _u32(buf, REQB_COUNT)
        if self._buffer_count < 2:
            raise V4L2Error(f"{self.device} : tampons insuffisants ({self._buffer_count})")

    def _map_buffers(self) -> None:
        for index in range(self._buffer_count):
            buf = bytearray(BUF_SIZE)
            struct.pack_into("<I", buf, BUF_INDEX, index)
            struct.pack_into("<I", buf, 4, V4L2_BUF_TYPE_VIDEO_CAPTURE)
            struct.pack_into("<I", buf, 60, V4L2_MEMORY_MMAP)
            self._ioctl(VIDIOC_QUERYBUF, buf)
            length = _u32(buf, BUF_LENGTH)
            offset = _u32(buf, BUF_MOFFSET)
            try:
                block = mmap.mmap(self._fd, length, mmap.PROT_READ | mmap.PROT_WRITE,
                                  mmap.MAP_SHARED, offset=offset)
            except OSError as exc:
                raise V4L2Error(f"mmap tampon {index} sur {self.device} : {exc.strerror or exc}") from exc
            self._buffers.append((block, length))

    def _qbuf(self, index: int) -> None:
        buf = bytearray(BUF_SIZE)
        struct.pack_into("<I", buf, BUF_INDEX, index)
        struct.pack_into("<I", buf, 4, V4L2_BUF_TYPE_VIDEO_CAPTURE)
        struct.pack_into("<I", buf, 60, V4L2_MEMORY_MMAP)
        self._ioctl(VIDIOC_QBUF, buf)

    def _queue_all(self) -> None:
        for index in range(len(self._buffers)):
            self._qbuf(index)

    # -- Boucle de capture ----------------------------------------------------

    def next_frame(self, timeout_s: float = 1.0) -> bytes | None:
        """Frame MJPEG suivante (bytes JPEG) ou ``None`` si aucune dans le délai.

        Non bloquant grâce à ``select`` : la boucle reste interruptible (arrêt,
        plus aucun client) et détecte la disparition du périphérique (EIO).
        """
        try:
            ready, _, _ = select.select([self._fd], [], [], timeout_s)
        except (OSError, ValueError) as exc:
            raise V4L2Error(f"{self.device} : attente de trame interrompue ({exc})") from exc
        if not ready:
            return None

        buf = bytearray(BUF_SIZE)
        struct.pack_into("<I", buf, 4, V4L2_BUF_TYPE_VIDEO_CAPTURE)
        struct.pack_into("<I", buf, 60, V4L2_MEMORY_MMAP)
        try:
            fcntl.ioctl(self._fd, VIDIOC_DQBUF, buf)
        except OSError as exc:
            if exc.errno == errno.EAGAIN:
                return None
            raise V4L2Error(f"{self.device} : trame illisible ({exc.strerror or exc}) — liaison perdue") from exc

        index, used = _u32(buf, BUF_INDEX), _u32(buf, BUF_USED)
        block, length = self._buffers[index]
        frame = bytes(block[:min(used, length)]) if 0 < used <= length else b""
        try:
            self._qbuf(index)  # remise immédiate du tampon dans la file du pilote
        except V4L2Error:
            pass
        return frame

    # -- Fermeture -------------------------------------------------------------

    def close(self) -> None:
        """Arrêt du flux et libération (best effort — le device peut avoir disparu)."""
        if self._fd >= 0:
            if self.streaming:
                try:
                    fcntl.ioctl(self._fd, VIDIOC_STREAMOFF, struct.pack("<I", V4L2_BUF_TYPE_VIDEO_CAPTURE))
                except OSError:
                    pass
                self.streaming = False
            for block, _length in self._buffers:
                try:
                    block.close()
                except (OSError, ValueError):
                    pass
            self._buffers.clear()
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = -1

    def __enter__(self) -> "V4L2Camera":
        self.open()
        return self

    def __exit__(self, *_exc) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Énumération des périphériques (section « Caméras » de la SPA)
# ---------------------------------------------------------------------------

def _enum_fourccs(fd: int) -> list[tuple[str, str]]:
    """Liste des formats supportés : [(fourcc, description), ...]."""
    formats: list[tuple[str, str]] = []
    for index in range(32):
        buf = bytearray(FMTD_SIZE)
        struct.pack_into("<I", buf, FMTD_INDEX, index)
        struct.pack_into("<I", buf, 4, V4L2_BUF_TYPE_VIDEO_CAPTURE)
        try:
            fcntl.ioctl(fd, VIDIOC_ENUM_FMT, buf)
        except OSError:
            break
        fourcc = struct.pack("<I", _u32(buf, FMTD_PXF)).decode("ascii", "replace")
        desc = bytes(buf[FMTD_DESC:FMTD_DESC + 32]).split(b"\x00")[0].decode("utf-8", "replace")
        formats.append((fourcc, desc.strip() or fourcc))
    return formats


def _enum_sizes(fd: int, fourcc: str) -> list[dict]:
    """Tailles de frame discrètes + cadences d'un format :

    ``[{"width": w, "height": h, "fps": [...]}, ...]``.
    """
    pxf = struct.unpack("<I", fourcc.encode("ascii"))[0]
    sizes: list[dict] = []
    for index in range(64):
        buf = bytearray(FRMS_SIZE)
        struct.pack_into("<I", buf, 0, index)
        struct.pack_into("<I", buf, 4, pxf)
        try:
            fcntl.ioctl(fd, VIDIOC_ENUM_FRAMESIZES, buf)
        except OSError:
            break
        if _u32(buf, FRMS_TYPE) != V4L2_FRMSIZE_TYPE_DISCRETE:
            break
        width, height = _u32(buf, FRMS_W), _u32(buf, FRMS_H)
        fps_list: list[float] = []
        for fi in range(32):
            ibuf = bytearray(FRMI_SIZE)
            struct.pack_into("<I", ibuf, 0, fi)
            struct.pack_into("<I", ibuf, 4, pxf)
            struct.pack_into("<I", ibuf, 8, width)
            struct.pack_into("<I", ibuf, 12, height)
            try:
                fcntl.ioctl(fd, VIDIOC_ENUM_FRAMEINTERVALS, ibuf)
            except OSError:
                break
            if _u32(ibuf, FRMI_TYPE) != V4L2_FRMIVAL_TYPE_DISCRETE:
                break
            num, den = _u32(ibuf, FRMI_NUM), _u32(ibuf, FRMI_DEN)
            if num > 0:
                fps_list.append(round(den / num, 2))
        sizes.append({"width": width, "height": height, "fps": sorted(set(fps_list), reverse=True)})
    return sizes


def _sysfs_name(device: str) -> str:
    """Nom de la carte lu dans sysfs (sans ouvrir le périphérique)."""
    try:
        return open(f"/sys/class/video4linux/{os.path.basename(device)}/name").read().strip()
    except OSError:
        return ""


def probe_device(device: str) -> dict | None:
    """Description d'un périphérique de capture (nom, formats, tailles) ou None.

    Un périphérique tenu par un autre processus (EBUSY : capture en cours des
    flux) reste listé — formats non énumérables à ce moment-là, ``busy: True``.
    """
    try:
        fd = os.open(device, os.O_RDWR | os.O_NONBLOCK)
    except OSError as exc:
        if exc.errno == errno.EBUSY:
            return {"device": device, "name": _sysfs_name(device) or device, "driver": "",
                    "busy": True, "mjpeg": True, "formats": []}
        return None
    try:
        caps = bytearray(104)
        try:
            fcntl.ioctl(fd, VIDIOC_QUERYCAP, caps)
        except OSError:
            return None
        # device_caps@88 (ce nœud) : exclut les nœuds metadata des webcams UVC.
        capabilities = _u32(caps, 88) or _u32(caps, 84)
        if not capabilities & V4L2_CAP_VIDEO_CAPTURE:
            return None  # nœud metadata ou codec : pas une caméra
        card = bytes(caps[16:48]).split(b"\x00")[0].decode("utf-8", "replace").strip()
        driver = bytes(caps[0:16]).split(b"\x00")[0].decode("utf-8", "replace").strip()
        formats = []
        for fourcc, desc in _enum_fourccs(fd):
            formats.append({"fourcc": fourcc, "description": desc, "sizes": _enum_sizes(fd, fourcc)})
        return {
            "device": device, "name": card or device, "driver": driver, "busy": False,
            "mjpeg": any(f["fourcc"] == "MJPG" for f in formats),
            "formats": formats,
        }
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def list_video_devices() -> list[dict]:
    """Caméras V4L2 utilisables (les nœuds metadata/codec sont filtrés)."""
    devices = []
    for path in sorted(glob.glob("/dev/video*"), key=lambda p: int(p.removeprefix("/dev/video") or 0)):
        info = probe_device(path)
        if info:
            devices.append(info)
    return devices


# ---------------------------------------------------------------------------
# Complément JPEG : certaines caméras UVC ne livrent pas les tables de Huffman
# ---------------------------------------------------------------------------

# La LifeCam HD-5000 produit un MJPEG « nu » : ni marqueur APP0/JFIF, ni tables
# de Huffman (DHT). Chromium comble en supposant les tables par défaut, mais
# WebKit (iPadOS/iOS, Chrome compris) refuse alors de décoder l'image — le
# flux est livré mais ne s'affiche pas. On insère donc, sans ré-encodage, les
# segments que le flux sous-entend (annexe K de la norme JPEG / JFIF).

_JPEG_APP0_JFIF = bytes.fromhex("ffe000104a46494600010100000100010000")

# (table, répartition des codes sur 16 niveaux, valeurs) — tables par défaut.
_JPEG_DEFAULT_TABLES = (
    (0x00, (0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0),
     (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)),
    (0x10, (0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125),
     (1, 2, 3, 0, 4, 17, 5, 18, 33, 49, 65, 6, 19, 81, 97, 7,
      34, 113, 20, 50, 129, 145, 161, 8, 35, 66, 177, 193, 21, 82, 209, 240,
      36, 51, 98, 114, 130, 9, 10, 22, 23, 24, 25, 26, 37, 38, 39, 40,
      41, 42, 52, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73,
      74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105,
      106, 115, 116, 117, 118, 119, 120, 121, 122, 131, 132, 133, 134, 135, 136, 137,
      138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167,
      168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196, 197,
      198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 225, 226,
      227, 228, 229, 230, 231, 232, 233, 234, 241, 242, 243, 244, 245, 246, 247, 248,
      249, 250)),
    (0x01, (0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0),
     (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)),
    (0x11, (0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119),
     (0, 1, 2, 3, 17, 4, 5, 33, 49, 6, 18, 65, 81, 7, 97, 113,
      19, 34, 50, 129, 8, 20, 66, 145, 161, 177, 193, 9, 35, 51, 82, 240,
      21, 98, 114, 209, 10, 22, 36, 52, 225, 37, 241, 23, 24, 25, 26, 38,
      39, 40, 41, 42, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72,
      73, 74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104,
      105, 106, 115, 116, 117, 118, 119, 120, 121, 122, 130, 131, 132, 133, 134, 135,
      136, 137, 138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165,
      166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195,
      196, 197, 198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218,
      226, 227, 228, 229, 230, 231, 232, 233, 234, 242, 243, 244, 245, 246, 247, 248,
      249, 250)),
)


def _build_default_dht() -> bytes:
    """Segment DHT complet (4 tables par défaut) prêt à insérer."""
    payload = bytearray()
    for table_id, counts, values in _JPEG_DEFAULT_TABLES:
        payload += bytes((table_id,)) + bytes(counts) + bytes(values)
    return b"\xff\xc4" + (len(payload) + 2).to_bytes(2, "big") + bytes(payload)


_JPEG_DEFAULT_DHT = _build_default_dht()


def _complete_jpeg(frame: bytes) -> bytes:
    """Réinsère APP0/JFIF + tables de Huffman par défaut dans un JPEG qui en
    est dépourvu. Sans DHT détecté et sans segment SOS identifiable, la frame
    est renvoyée intacte."""
    if not frame.startswith(b"\xff\xd8") or b"\xff\xc4" in frame:
        return frame
    i = 2
    while i + 4 <= len(frame):
        if frame[i] != 0xFF:
            return frame
        marker = frame[i + 1]
        if marker == 0xDA:               # SOS : insérer les tables juste avant
            return (frame[:2] + _JPEG_APP0_JFIF
                    + frame[2:i] + _JPEG_DEFAULT_DHT + frame[i:])
        if marker == 0x01 or 0xD0 <= marker <= 0xD9:
            return frame                 # structure inattendue : ne pas toucher
        length = (frame[i + 2] << 8) | frame[i + 3]
        if length < 2:
            return frame
        i += 2 + length
    return frame


# ---------------------------------------------------------------------------
# Source caméra : thread superviseur + frames partagées
# ---------------------------------------------------------------------------

class CameraSource:
    """Une caméra du cockpit : capture continue tant qu'un client la regarde.

    Les frames sont partagées entre tous les abonnés (aucune duplication) ;
    quand le dernier client se déconnecte, la capture s'arrête après
    ``_IDLE_STOP_S`` secondes — la LED s'éteint et le bus USB se libère.
    """

    def __init__(self, name: str):
        self.name = name
        self._lock = threading.Lock()
        self._frame_cond = threading.Condition(self._lock)
        self._frame: bytes | None = None
        self._frame_id = 0
        self._last_frame_ts = 0.0
        self._clients = 0
        self._last_unsub_ts = 0.0
        self._stop = threading.Event()
        self._reload = threading.Event()
        self._thread: threading.Thread | None = None
        self._state = "idle"          # idle | streaming | error
        self._last_error: str | None = None
        self._device = ""
        self._card = ""
        self._stream_fps = 0.0        # cadence de capture mesurée
        self._frames_total = 0
        self._dropped = 0
        self._started_at = 0.0

    # -- Cycle de vie ----------------------------------------------------------

    def start(self) -> None:
        """Lance le thread superviseur (unique, daemon)."""
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._supervisor, name=f"bobrov-video-{self.name}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Arrête définitivement le superviseur (arrêt de l'application)."""
        self._reload.clear()
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3.0)

    def force_reload(self) -> None:
        """Ferme la capture courante : le superviseur la rouvrira avec la nouvelle config."""
        self._reload.set()

    # -- Abonnés ---------------------------------------------------------------

    def add_client(self, quiet: bool = False) -> int:
        """Abonnement d'un client (flux continu ou sonde de frame).

        ``quiet`` : les sondes de frames (repli WebKit iPadOS/iOS) s'abonnent à
        chaque requête — leurs allers-retours ne sont pas journalisés.
        """
        with self._lock:
            self._clients += 1
            count = self._clients
        if not quiet:
            log.info("[%s] client vidéo connecté (%d au total)", self.name, count)
        return count

    def remove_client(self, quiet: bool = False) -> None:
        with self._lock:
            self._clients = max(0, self._clients - 1)
            self._last_unsub_ts = time.monotonic()
            count = self._clients
        if not quiet:
            log.info("[%s] client vidéo déconnecté (%d restant%s)", self.name, count, "s" if count > 1 else "")

    def wait_frame(self, after_id: int, timeout: float = 0.0) -> tuple[int, bytes] | None:
        """Dernière frame si plus récente que ``after_id``, sinon None (attente ≤ timeout)."""
        with self._frame_cond:
            if self._frame_id > after_id and self._frame is not None:
                return self._frame_id, self._frame
            if timeout > 0:
                self._frame_cond.wait(timeout)
                if self._frame_id > after_id and self._frame is not None:
                    return self._frame_id, self._frame
            return None

    def wait_fresh_frame(self, max_age_s: float, timeout: float = 0.0) -> tuple[int, bytes] | None:
        """Dernière frame seulement si récente (< ``max_age_s``), sinon None (attente ≤ timeout).

        Sonde de frames : une image figée (caméra en panne mais encore dans le
        tampon) ne doit jamais être resservie comme un flux vivant — au poste
        de pilotage, l'utilisateur la croirait en direct.
        """
        deadline = time.monotonic() + timeout
        with self._frame_cond:
            while True:
                fresh = (self._frame is not None
                         and time.monotonic() - self._last_frame_ts <= max_age_s)
                if fresh:
                    return self._frame_id, self._frame
                remaining = deadline - time.monotonic()
                if timeout <= 0 or remaining <= 0:
                    return None
                self._frame_cond.wait(remaining)

    def get_status(self) -> dict:
        with self._lock:
            return {
                "name": self.name,
                "state": self._state,
                "device": self._device,
                "card": self._card,
                "clients": self._clients,
                "frames_total": self._frames_total,
                "dropped": self._dropped,
                "stream_fps": round(self._stream_fps, 1),
                "age_s": round(time.monotonic() - self._last_frame_ts, 2) if self._last_frame_ts else None,
                "last_error": self._last_error,
            }

    # -- Capture ---------------------------------------------------------------

    def _publish(self, frame: bytes) -> None:
        frame = _complete_jpeg(frame)    # DHT par défaut si la caméra en manque
        with self._frame_cond:
            self._frame = frame
            self._frame_id += 1
            self._last_frame_ts = time.monotonic()
            self._frames_total += 1
            self._frame_cond.notify_all()

    def _camera_config(self) -> dict:
        cam = get_config().get_section("cameras").get(self.name, {})
        return {
            "device": str(cam.get("device", "")),
            "width": int(cam.get("width", 640)),
            "height": int(cam.get("height", 480)),
            "fps": float(cam.get("fps", 30)),
        }

    def _supervisor(self) -> None:
        """Boucle infinie : capture si des clients sont abonnés, sinon veille."""
        while not self._stop.is_set():
            self._reload.clear()
            with self._lock:
                clients = self._clients
            if clients == 0:
                with self._lock:
                    self._state = "idle"
                self._stop.wait(0.2)
                continue
            try:
                self._capture_session()
            except V4L2Error as exc:
                with self._lock:
                    self._state = "error"
                    self._last_error = str(exc)
                log.warning("[%s] ERREUR : %s — nouvelle tentative dans %gs", self.name, exc, _RECONNECT_DELAY_S)
                self._stop.wait(_RECONNECT_DELAY_S)
        with self._lock:
            self._state = "idle"

    def _capture_session(self) -> None:
        """Ouvre la caméra et lit les frames jusqu'à fin d'abonnement ou rechargement."""
        cfg = self._camera_config()
        if not cfg["device"]:
            raise V4L2Error(f"cameras.{self.name}.device non configuré")
        with V4L2Camera(cfg["device"], cfg["width"], cfg["height"], cfg["fps"]) as cam:
            with self._lock:
                self._state = "streaming"
                self._last_error = None
                self._device = cam.device
                self._card = cam.card
                self._started_at = time.monotonic()
            log.info("[%s] %s ouverte : « %s » MJPEG %dx%d @%g fps cible — capture démarrée",
                     self.name, cam.device, cam.card, cam.width, cam.height, cfg["fps"])
            window_start = time.monotonic()
            window_frames = 0
            last_log = window_start
            while not self._stop.is_set() and not self._reload.is_set():
                # Arrêt seulement après une vraie période sans abonné : un simple
                # rechargement de page (déconnexion/reconnexion immédiate) ne
                # coupe pas la capture.
                with self._lock:
                    if self._clients == 0:
                        idle = time.monotonic() - self._last_unsub_ts if self._last_unsub_ts else 1e9
                        if idle > _IDLE_STOP_S:
                            break
                frame = cam.next_frame(timeout_s=1.0)
                if frame is None:
                    continue
                if len(frame) > 4 and frame[:2] == b"\xff\xd8" and frame[-2:] == b"\xff\xd9":
                    self._publish(frame)
                    window_frames += 1
                else:
                    with self._lock:
                        self._dropped += 1
                now = time.monotonic()
                elapsed = now - window_start
                if elapsed >= 1.0:
                    with self._lock:
                        self._stream_fps = window_frames / elapsed
                    window_frames, window_start = 0, now
                if now - last_log >= 5.0:
                    log.info("[%s] capture : %.1f fps | %.0f trames cumulées | %d client(s)",
                             self.name, self._stream_fps, self._frames_total, self._clients)
                    last_log = now
        reason = "rechargement" if self._reload.is_set() else ("arrêt" if self._stop.is_set() else "aucun client")
        with self._lock:
            if self._state == "streaming":
                self._state = "idle"
        log.info("[%s] capture arrêtée (%s)", self.name, reason)


# ---------------------------------------------------------------------------
# Gestionnaire global (cam1 + cam2)
# ---------------------------------------------------------------------------

class VideoManager:
    """Singleton des deux caméras du cockpit (cycle de vie lié à FastAPI)."""

    def __init__(self) -> None:
        self._sources = {"cam1": CameraSource("cam1"), "cam2": CameraSource("cam2")}

    def start(self) -> None:
        for source in self._sources.values():
            source.start()

    def stop(self) -> None:
        for source in self._sources.values():
            source.stop()

    def source(self, name: str) -> CameraSource | None:
        return self._sources.get(name)

    def reload(self) -> None:
        """Applique la configuration courante à la prochaine capture."""
        for source in self._sources.values():
            source.force_reload()
        log.info("rechargement des flux demandé (prochaine capture à la nouvelle config)")

    def get_status(self) -> dict:
        return {name: source.get_status() for name, source in self._sources.items()}


VIDEO = VideoManager()


def get_video() -> VideoManager:
    """Accès au gestionnaire vidéo global (deux caméras)."""
    return VIDEO


# ---------------------------------------------------------------------------
# Flux HTTP MJPEG
# ---------------------------------------------------------------------------

async def mjpeg_stream(source: CameraSource):
    """Générateur async du flux ``multipart/x-mixed-replace`` d'une caméra.

    Se termine proprement si aucune frame pendant ``_STALL_TIMEOUT_S`` (caméra
    absente ou perdue) : le client JS reprend la main et affiche « pas de
    signal » — jamais de flux infini sans image.
    """
    source.add_client()
    last_id = 0
    deadline = time.monotonic() + _STALL_TIMEOUT_S
    try:
        while True:
            got = source.wait_frame(last_id, timeout=0.0)
            if got is None:
                if time.monotonic() > deadline:
                    log.info("[%s] flux terminé : aucune image depuis %.0fs", source.name, _STALL_TIMEOUT_S)
                    return
                await asyncio.sleep(0.01)
                continue
            last_id, frame = got
            deadline = time.monotonic() + _STALL_TIMEOUT_S
            header = ("--%s\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n"
                      % (_MJPEG_BOUNDARY, len(frame))).encode("ascii")
            yield header + frame + b"\r\n"
    finally:
        source.remove_client()


# ---------------------------------------------------------------------------
# Routes /api/video
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/video", tags=["video"])


@router.get("/status", summary="État des flux vidéo")
async def video_status() -> dict:
    """État temps réel de cam1/cam2 (sans énumération des devices — léger)."""
    return {"status": "ok", "cameras": get_video().get_status()}


@router.get("/devices", summary="Caméras V4L2 disponibles")
async def video_devices() -> dict:
    """Liste des périphériques de capture avec formats, tailles et cadences."""
    return {"status": "ok", "devices": list_video_devices()}


@router.post("/reload", summary="Recharger les flux")
async def video_reload() -> dict:
    """Force la réouverture des caméras à la configuration courante."""
    get_video().reload()
    return {"status": "ok"}


@router.get("/frame/{cam}", summary="Dernière frame JPEG d'une caméra")
async def video_frame(cam: str) -> Response:
    """Image JPEG unique — repli des navigateurs WebKit (iPadOS/iOS, Chrome compris)
    qui n'affichent pas le flux multipart/x-mixed-replace dans une balise <img>.

    S'abonne le temps d'obtenir une image fraîche (jamais une frame figée :
    même seuil de fraîcheur que le flux MJPEG) puis se retire : les sondages
    rapprochés du client maintiennent la capture active, l'arrêt de veille ne
    survient qu'après la fermeture du client.
    """
    source = get_video().source(cam)
    if source is None:
        raise HTTPException(status_code=404, detail=f"caméra inconnue : {cam} (cam1, cam2)")
    source.add_client(quiet=True)
    try:
        got = await asyncio.to_thread(source.wait_fresh_frame, _STALL_TIMEOUT_S, _FRAME_WAIT_TIMEOUT_S)
        if got is None:
            raise HTTPException(status_code=503, detail="aucune image disponible pour l'instant")
        return Response(
            content=got[1],
            media_type="image/jpeg",
            headers={"Cache-Control": "no-store, no-cache", "Pragma": "no-cache"},
        )
    finally:
        source.remove_client(quiet=True)


@router.get("/{cam}", summary="Flux MJPEG d'une caméra")
async def video_feed(cam: str) -> StreamingResponse:
    """Flux MJPEG indépendant (``multipart/x-mixed-replace``) de cam1 ou cam2."""
    source = get_video().source(cam)
    if source is None:
        raise HTTPException(status_code=404, detail=f"caméra inconnue : {cam} (cam1, cam2)")
    return StreamingResponse(
        mjpeg_stream(source),
        media_type=f"multipart/x-mixed-replace; boundary={_MJPEG_BOUNDARY}",
        headers={"Cache-Control": "no-store, no-cache", "Pragma": "no-cache", "X-Camera": cam},
    )
