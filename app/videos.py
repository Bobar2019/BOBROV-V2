"""Médiathèque « Mes Vidéos » — vidéos et photos locales, notes et étoiles.

Les médias vivent dans le dossier ``videos.folder`` de config.json (défaut
``videos/`` à la racine du projet, créé au besoin). Chaque média peut recevoir
une note texte et une évaluation en étoiles (0–5), persistées dans un index
JSON discret ``.bobrov_index.json`` posé à côté des fichiers — supprimer un
média n'affecte jamais l'index des autres.

Le cockpit dépose ici ses enregistrements (``POST /upload``, corps binaire :
photo JPEG ou vidéo WebM issue du navigateur) ; la vue « MES VIDÉOS » y
supprime (``DELETE /file/{name}``) et renomme (``POST /rename``, la fiche
notes/étoiles suit le fichier).

Service des fichiers : ``FileResponse`` (Starlette) gère nativement les
requêtes ``Range`` — le lecteur HTML5 peut donc se déplacer dans la vidéo sans
tout télécharger. La durée est extraite en pur Python pour MP4/MOV/M4V
(box ``mvhd``) ; les autres conteneurs affichent « durée inconnue ».

Sécurité : les noms demandés passent par ``resolve()`` — aucun caractère de
chemin, extension vidéo ou photo imposée, le fichier doit exister dans le
dossier ; les dépôts sont plafonnés (1 Gio) et jamais écrasants.
"""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import struct
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

from app.config import PROJECT_ROOT, get_config

log = logging.getLogger("bobrov.videos")

VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".mpe", ".mpeg", ".mpg"}
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ALL_EXTENSIONS = VIDEO_EXTENSIONS | PHOTO_EXTENSIONS
INDEX_FILE = ".bobrov_index.json"
MAX_NOTES_LEN = 5000
MAX_INDEX_BYTES = 4 * 1024 * 1024
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024           # 1 Gio : au-delà, dépôt refusé (413)


class LibraryError(ValueError):
    """Vidéo inconnue, nom invalide ou hors dossier — traité en 404 par les routes."""


class LibraryConflictError(LibraryError):
    """Cible déjà occupée (renommage) — traité en 409 par les routes."""


# ---------------------------------------------------------------------------
# Durée MP4/MOV (box mvhd) — sans ffprobe, sans dépendance
# ---------------------------------------------------------------------------

def _iter_boxes(fh, start: int, end: int):
    """Itère les boîtes ISO BMFF (offset, type, taille, taille d'en-tête).

    La position du fichier est resynchronisée sur ``pos`` à chaque tour : le
    lecteur appelant peut avoir déplacé le curseur entre deux itérations.
    """
    pos = start
    while pos + 8 <= end:
        fh.seek(pos)
        header = fh.read(8)
        if len(header) < 8:
            return
        size, kind = struct.unpack(">I4s", header)
        header_size = 8
        if size == 1:                       # largesize (64 bits)
            extra = fh.read(8)
            if len(extra) < 8:
                return
            size = struct.unpack(">Q", extra)[0]
            header_size = 16
        elif size == 0:                     # boîte jusqu'à la fin du fichier
            size = end - pos
        if size < header_size:
            return
        yield pos, kind, size, header_size
        pos += size


def mp4_duration_s(path: Path) -> float | None:
    """Durée en secondes d'un MP4/MOV (box ``mvhd``), ``None`` si illisible."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            file_size = fh.tell()
            for pos, kind, size, header_size in _iter_boxes(fh, 0, file_size):
                if kind != b"moov":
                    continue
                box_end = min(pos + size, file_size)
                for mpos, mkind, _msize, mhsize in _iter_boxes(fh, pos + header_size, box_end):
                    if mkind != b"mvhd":
                        continue
                    fh.seek(mpos + mhsize)
                    data = fh.read(32)
                    if len(data) < 20:
                        return None
                    if data[0] == 1:        # version 1 : timescale/duration 64 bits
                        timescale = int.from_bytes(data[20:24], "big")
                        duration = int.from_bytes(data[24:32], "big")
                    else:                   # version 0 : 32 bits
                        timescale = int.from_bytes(data[12:16], "big")
                        duration = int.from_bytes(data[16:20], "big")
                    if timescale > 0 and duration > 0:
                        return duration / timescale
                    return None
    except (OSError, struct.error):
        return None
    return None


# ---------------------------------------------------------------------------
# Bibliothèque
# ---------------------------------------------------------------------------

class VideosLibrary:
    """Accès thread-safe au dossier vidéos et à l'index notes/étoiles."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.folder_override: Path | None = None   # utilisé par les tests

    # -- Dossier & index -------------------------------------------------------

    def folder(self) -> Path:
        if self.folder_override is not None:
            base = self.folder_override
        else:
            rel = str(get_config().get()["videos"]["folder"])
            base = Path(rel) if os.path.isabs(rel) else PROJECT_ROOT / rel
        base.mkdir(parents=True, exist_ok=True)
        return base

    def _index_path(self) -> Path:
        return self.folder() / INDEX_FILE

    def _load_index(self) -> dict:
        path = self._index_path()
        if not path.exists():
            return {}
        try:
            if path.stat().st_size > MAX_INDEX_BYTES:
                log.warning("%s anormalement gros — index ignoré", path)
                return {}
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("index vidéos illisible (%s) — réinitialisé", exc)
            return {}

    def _save_index(self, index: dict) -> None:
        path = self._index_path()
        tmp = path.with_name(path.name + ".tmp")
        try:
            tmp.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            os.replace(tmp, path)
        except OSError as exc:
            raise LibraryError(f"écriture de l'index vidéos impossible : {exc}") from exc

    # -- Résolution sécurisée ----------------------------------------------------

    def resolve(self, name: str) -> Path:
        """Chemin absolu d'un média du dossier — rejette tout nom douteux."""
        if (not name or name != Path(name).name or "/" in name or "\\" in name
                or name in (".", "..") or name.startswith(".")):
            raise LibraryError(f"nom de média invalide : {name!r}")
        if Path(name).suffix.lower() not in ALL_EXTENSIONS:
            raise LibraryError(f"extension non supportée pour {name!r}")
        path = self.folder() / name
        if not path.is_file():
            raise LibraryError(f"média introuvable : {name}")
        return path

    # -- API publique -------------------------------------------------------------

    def list_items(self) -> list[dict]:
        """Tous les médias du dossier, plus récents d'abord (index fusionné)."""
        with self._lock:
            folder = self.folder()
            index = self._load_index()
            items = []
            for path in folder.iterdir():
                suffix = path.suffix.lower()
                if suffix not in ALL_EXTENSIONS or not path.is_file():
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                meta = index.get(path.name, {})
                items.append({
                    "name": path.name,
                    "kind": "photo" if suffix in PHOTO_EXTENSIONS else "video",
                    "size_bytes": stat.st_size,
                    "mtime": stat.st_mtime,
                    "duration_s": (mp4_duration_s(path)
                                   if suffix in (".mp4", ".mov", ".m4v") else None),
                    "stars": int(meta.get("stars", 0) or 0),
                    "notes": str(meta.get("notes", "") or ""),
                })
            items.sort(key=lambda item: item["mtime"], reverse=True)
            return items

    def meta_get(self, name: str) -> dict:
        """Notes/étoiles d'une vidéo (0 et chaîne vide si jamais annotée)."""
        self.resolve(name)
        with self._lock:
            meta = self._load_index().get(name, {})
        return {"stars": int(meta.get("stars", 0) or 0), "notes": str(meta.get("notes", "") or "")}

    def meta_set(self, name: str, stars: int | None = None, notes: str | None = None) -> dict:
        """Met à jour étoiles et/ou notes ; une fiche vide est retirée de l'index."""
        self.resolve(name)
        if stars is not None and (not isinstance(stars, int) or isinstance(stars, bool) or not 0 <= stars <= 5):
            raise LibraryError("stars : entier attendu entre 0 et 5")
        if notes is not None and (not isinstance(notes, str) or len(notes) > MAX_NOTES_LEN):
            raise LibraryError(f"notes : texte attendu (max {MAX_NOTES_LEN} caractères)")
        with self._lock:
            index = self._load_index()
            current = index.get(name, {})
            new_stars = int(current.get("stars", 0)) if stars is None else stars
            new_notes = str(current.get("notes", "")) if notes is None else notes
            if new_stars == 0 and not new_notes.strip():
                index.pop(name, None)
            else:
                index[name] = {"stars": new_stars, "notes": new_notes}
            self._save_index(index)
            log.info("fiche vidéo mise à jour : %s (%s étoile%s, notes %s)",
                     name, new_stars, "s" if new_stars > 1 else "",
                     f"{len(new_notes)} caractères" if new_notes else "vides")
        return {"stars": new_stars, "notes": new_notes}

    def delete(self, name: str) -> dict:
        """Supprime définitivement un média et retire sa fiche de l'index."""
        path = self.resolve(name)
        with self._lock:
            try:
                path.unlink()
            except OSError as exc:
                raise LibraryError(f"suppression impossible : {exc}") from exc
            index = self._load_index()
            if index.pop(name, None) is not None:
                self._save_index(index)
            log.info("média supprimé : %s", name)
        return {"name": name}

    def rename(self, name: str, new_name: str) -> dict:
        """Renomme un média et fait suivre sa fiche notes/étoiles.

        ``new_name`` est un simple nom de fichier ; fourni sans extension,
        celle d'origine est conservée (le média garde son type). Un nom déjà
        occupé est refusé : un renommage n'écrase jamais l'existant.
        """
        path = self.resolve(name)
        new_name = str(new_name or "").strip()
        if (not new_name or new_name != Path(new_name).name or "/" in new_name
                or "\\" in new_name or new_name in (".", "..") or new_name.startswith(".")):
            raise LibraryError(f"nouveau nom invalide : {new_name!r}")
        if not Path(new_name).suffix:
            new_name += path.suffix
        if Path(new_name).suffix.lower() not in ALL_EXTENSIONS:
            raise LibraryError(f"extension non supportée pour {new_name!r}")
        with self._lock:
            target = self.folder() / new_name
            if target == path:
                return {"name": name}                   # même nom : rien à faire
            if target.exists():
                raise LibraryConflictError(f"un média nommé « {new_name} » existe déjà")
            try:
                path.rename(target)
            except OSError as exc:
                raise LibraryError(f"renommage impossible : {exc}") from exc
            index = self._load_index()
            meta = index.pop(name, None)
            if meta is not None:
                index[new_name] = meta
                self._save_index(index)
            log.info("média renommé : %s → %s", name, new_name)
        return {"name": new_name}

    def prepare_upload(self, name: str) -> Path:
        """Valide un nom de dépôt et réserve un chemin unique dans le dossier.

        Le nom doit être un simple nom de fichier (jamais de chemin), avec une
        extension vidéo ou photo connue. En cas de collision, un suffixe
        ``-1``, ``-2``… est ajouté : un dépôt n'écrase jamais l'existant.
        """
        if (not name or name != Path(name).name or "/" in name or "\\" in name
                or name in (".", "..") or name.startswith(".")):
            raise LibraryError(f"nom de fichier invalide : {name!r}")
        if Path(name).suffix.lower() not in ALL_EXTENSIONS:
            raise LibraryError(f"extension non supportée pour {name!r}")
        with self._lock:
            folder = self.folder()
            candidate = folder / name
            stem, suffix = Path(name).stem, Path(name).suffix
            counter = 1
            while candidate.exists():
                candidate = folder / f"{stem}-{counter}{suffix}"
                counter += 1
            return candidate


LIBRARY = VideosLibrary()


def get_library() -> VideosLibrary:
    """Accès à la médiathèque globale."""
    return LIBRARY


# ---------------------------------------------------------------------------
# Routes /api/videos
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/videos", tags=["videos"])


@router.get("", summary="Liste de la médiathèque")
async def videos_list() -> dict:
    """Vidéos du dossier configuré, avec notes/étoiles et durées."""
    library = get_library()
    items = library.list_items()
    return {"status": "ok", "folder": str(library.folder()), "count": len(items), "items": items}


@router.get("/file/{name}", summary="Fichier vidéo (Range supporté)")
async def videos_file(name: str) -> FileResponse:
    """Sert la vidéo — les requêtes Range de la balise ``<video>`` sont gérées."""
    try:
        path = get_library().resolve(name)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    media_type, _ = mimetypes.guess_type(path.name)
    return FileResponse(path, media_type=media_type or "application/octet-stream")


@router.delete("/file/{name}", summary="Supprimer un média")
async def videos_delete(name: str) -> dict:
    """Suppression définitive d'un fichier — notes/étoiles retirés avec lui."""
    try:
        return {"status": "ok", **get_library().delete(name)}
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/rename", summary="Renommer un média")
async def videos_rename(payload: dict) -> dict:
    """Corps : ``{"name": "actuel.webm", "new_name": "nouveau"}``.

    L'extension d'origine est conservée si ``new_name`` n'en porte pas.
    """
    name = payload.get("name")
    new_name = payload.get("new_name")
    if not isinstance(name, str) or not isinstance(new_name, str):
        raise HTTPException(status_code=422, detail="name et new_name : textes attendus")
    library = get_library()
    try:
        library.resolve(name)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        renamed = library.rename(name, new_name)
    except LibraryConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LibraryError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"status": "ok", "old_name": name, **renamed}


@router.post("/upload", summary="Déposer un média (corps binaire)")
async def videos_upload(request: Request, name: str = Query(..., min_length=1)) -> dict:
    """Reçoit un fichier brut (photo JPEG ou vidéo WebM du cockpit).

    Le nom passe en query string ; le corps est écrit en flux dans un
    ``.part`` plafonné à ``MAX_UPLOAD_BYTES``, puis renommé proprement.
    """
    library = get_library()
    try:
        target = library.prepare_upload(name)
    except LibraryError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    tmp = target.with_name(target.name + ".part")
    received = 0
    try:
        with open(tmp, "wb") as handle:
            async for chunk in request.stream():
                received += len(chunk)
                if received > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413,
                                        detail="fichier trop volumineux (max 1 Gio)")
                handle.write(chunk)
        if received == 0:
            raise HTTPException(status_code=422, detail="corps vide — aucun octet reçu")
        os.replace(tmp, target)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"écriture impossible : {exc}") from exc
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    log.info("média déposé : %s (%d octets)", target.name, received)
    return {"status": "ok", "name": target.name, "size_bytes": received}


@router.get("/meta/{name}", summary="Notes et étoiles")
async def videos_meta_get(name: str) -> dict:
    try:
        meta = get_library().meta_get(name)
    except LibraryError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"status": "ok", "name": name, **meta}


@router.post("/meta/{name}", summary="Enregistrer notes et/ou étoiles")
async def videos_meta_set(name: str, payload: dict) -> dict:
    """Corps : {"stars": 0-5, "notes": "…"} — chaque champ est optionnel."""
    stars = payload.get("stars")
    notes = payload.get("notes")
    if stars is None and notes is None:
        raise HTTPException(status_code=422, detail="aucun champ à mettre à jour (stars, notes)")
    try:
        meta = get_library().meta_set(name, stars=stars, notes=notes)
    except LibraryError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"status": "ok", "name": name, **meta}
