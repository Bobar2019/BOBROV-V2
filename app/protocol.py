"""Module protocole BOB-CONTROL ↔ cockpit BOBROV — pur, sans aucune I/O.

Implémentation conforme à PROTOCOLE_RPI5.md (v1.5.0) :
- trame descendante de commande : 40 octets, type 0x01 (§4) ;
- requête de synchronisation descendante : 40 octets, type 0xFF (§4.4) ;
- trame montante de télémétrie : 73 octets, type 0x02 (§5) ;
- trames montantes de noms : 27 octets, types 0x03/0x04 (§5.6) ;
- CRC16-CCITT-FALSE sur chaque trame, stocké en big-endian (§3.2) ;
- réassemblage tolérant d'un flux bruité, resynchronisation octet par octet (§3.3).

Tous les champs multi-octets sont en little-endian, sauf le CRC (big-endian).
Les paramètres de liaison (port, débit, cadence) vivent dans config.json —
ce module ne fait aucune I/O et se valide seul contre les vecteurs §8.
"""
from __future__ import annotations

import struct

# ==================== Constantes du protocole ====================

# Masque d'assistances superposables (v1.4.0) — combiner avec |
MODE_PASSIF = 0x00
MODE_RT = 0x01        # Auto Roulis/Tangage
MODE_DEPTH = 0x02     # Tenue de profondeur
MODE_CAP = 0x04       # Auto Cap (lacet)
MODE_SURFACE = 0x08   # Retour surface (prioritaire)

ARM_DISARMED, ARM_ARMED, ARM_ESTOP = 0, 1, 2

# Bits du champ `status` de la télémétrie (§5.1)
STATUS_ARMED = 0x02    # liaison établie (≥ 1 trame descendante valide reçue) — PAS l'armement courant
STATUS_RT = 0x04       # Auto Roulis/Tangage réellement actif
STATUS_WDG = 0x08      # watchdog série déclenché
STATUS_DRYRUN = 0x10   # sorties physiques PCA9685 neutralisées
STATUS_DEPTH = 0x20    # tenue de profondeur réellement active
STATUS_CAP = 0x40      # Auto Cap réellement actif
STATUS_SURFACE = 0x80  # retour surface réellement actif

# Types de trames (octet à l'offset 2)
DL_CMD = 0x01          # descendante : commande
DL_SYNC = 0xFF         # descendante : requête de synchronisation (§4.4)
UL_TELEMETRY = 0x02    # montante : télémétrie
UL_CFG_PWM = 0x03      # montante : nom d'un canal PWM auxiliaire (10–15)
UL_CFG_GPIO = 0x04     # montante : nom d'une sortie tout-ou-rien (1–4)

# Tailles fixes (v1.5.0) : la taille montante se déduit du type (§3.3)
DL_FRAME_SIZE = 40
FRAME_SIZES = {UL_TELEMETRY: 73, UL_CFG_PWM: 27, UL_CFG_GPIO: 27}


# ==================== CRC16-CCITT-FALSE ====================

def crc16_ccitt(data: bytes) -> int:
    """CRC16-CCITT-FALSE : polynôme 0x1021, init 0xFFFF, ni réflexion ni XOR final.

    Valeur de contrôle (§8.1) : ``crc16_ccitt(b'123456789') == 0x29B1``.
    """
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


# ==================== Trame descendante (40 octets) ====================

def build_downlink_frame(mode: int, arm_state: int, pwm_us, gpio_cmd: int = 0) -> bytes:
    """Construit la trame de commande RPi 5 → ESP32-S3 (40 octets, type 0x01).

    mode : masque d'assistances superposables (MODE_RT | MODE_DEPTH | …).
    pwm_us : séquence de 16 consignes en microsecondes, transmises telles quelles
             (le firmware borne à 1000–2000 µs) ; ``pwm[k]`` aux offsets 5 + 2k.
    gpio_cmd : masque 4 bits des sorties ON/OFF (bit 0 = sortie 1, 1 = ON).

    CRC sur ``[2..37]``, stocké big-endian en ``[38]``/``[39]``.
    """
    payload = struct.pack('<BBB16HB', DL_CMD, mode, arm_state, *pwm_us, gpio_cmd)
    crc = crc16_ccitt(payload)                                    # CRC sur [2..37]
    return bytes((0xAA, 0x55)) + payload + struct.pack('>H', crc)  # CRC big-endian


def build_sync_request() -> bytes:
    """Requête de synchronisation (40 octets, type 0xFF) — §4.4.

    Contenu (offsets 3 à 37) ignoré par le firmware : des zéros suffisent.
    Déclenche la rafale des noms personnalisés (trames 0x03/0x04) et réarme
    le watchdog. À envoyer au démarrage du cockpit.
    """
    payload = struct.pack('<B35x', DL_SYNC)                       # type 0xFF + 35 zéros
    crc = crc16_ccitt(payload)                                    # CRC sur [2..37]
    return bytes((0xAA, 0x55)) + payload + struct.pack('>H', crc)  # CRC big-endian


# ==================== Trame montante (73 octets) ====================

def parse_uplink_frame(frame: bytes) -> dict:
    """Valide et décode une trame de télémétrie (73 octets, type 0x02) — §5.

    Lève ``ValueError`` si la taille, l'en-tête ou le CRC sont incorrects.
    Conversions appliquées : quaternion ÷ 10000, gyro ÷ 100 (°/s),
    pression ÷ 10 (mbar), température ÷ 100 (°C) ; ``power`` (mV/mA) et
    ``pwm_actual`` (µs) restent en valeurs entières brutes.
    """
    if len(frame) != 73:
        raise ValueError(f'trame de {len(frame)} octets (attendu 73)')
    if frame[0] != 0x55 or frame[1] != 0xAA or frame[2] != UL_TELEMETRY:
        raise ValueError('en-tête invalide')
    if (frame[71] << 8 | frame[72]) != crc16_ccitt(frame[2:71]):   # CRC sur [2..70]
        raise ValueError('CRC16 invalide')
    (_, status, w, x, y, z, gx, gy, gz, pressure, temperature, *rest) = \
        struct.unpack_from('<BB4h3h2i6H16HB', frame, 2)
    return {
        'status': status,
        'armed': bool(status & STATUS_ARMED),        # liaison établie (≥ 1 trame reçue)
        'auto_rt': bool(status & STATUS_RT),         # Auto Roulis/Tangage réellement actif
        'depth_hold': bool(status & STATUS_DEPTH),   # tenue de profondeur active
        'cap_hold': bool(status & STATUS_CAP),       # Auto Cap actif
        'surface': bool(status & STATUS_SURFACE),    # retour surface prioritaire actif
        'watchdog': bool(status & STATUS_WDG),       # watchdog série déclenché
        'dry_run': bool(status & STATUS_DRYRUN),     # sorties PCA9685 neutralisées
        'quat': (w / 10000.0, x / 10000.0, y / 10000.0, z / 10000.0),
        'gyro': (gx / 100.0, gy / 100.0, gz / 100.0),                  # °/s
        'pressure_mbar': pressure / 10.0,                              # mbar absolus
        'temperature_c': temperature / 100.0,                          # °C
        'power': list(rest[:6]),       # [V_BAT, réservé, signal_H, I_H, signal_V, I_V] mV/mA
        'pwm_us': list(rest[6:22]),    # 16 consignes courantes (µs)
        'gpio_state': rest[22],        # état relu des 4 sorties ON/OFF (bit 0 = sortie 1)
    }


# ==================== Trames de configuration des noms (27 octets) ====================

def parse_config_frame(frame: bytes) -> dict:
    """Valide et décode une trame de configuration des noms (27 octets, 0x03/0x04) — §5.6.

    Lève ``ValueError`` si la taille, l'en-tête/type, le CRC ou ``name_len``
    sont incorrects. ``name_len = 0`` ⇒ nom par défaut côté cockpit.
    """
    if len(frame) != 27:
        raise ValueError(f'trame de {len(frame)} octets (attendu 27)')
    if frame[0] != 0x55 or frame[1] != 0xAA or frame[2] not in (UL_CFG_PWM, UL_CFG_GPIO):
        raise ValueError('en-tête ou type invalide')
    if (frame[25] << 8 | frame[26]) != crc16_ccitt(frame[2:25]):   # CRC sur [2..24]
        raise ValueError('CRC16 invalide')
    name_len = frame[4]
    if name_len > 20:
        raise ValueError('name_len > 20')
    return {
        'kind': 'pwm' if frame[2] == UL_CFG_PWM else 'gpio',
        'id': frame[3],                                      # canal 10–15 | sortie 1–4
        'name': frame[5:5 + name_len].decode('utf-8', errors='replace'),
        'default_name': name_len == 0,                       # → appliquer le libellé par défaut
    }


# ==================== Réassemblage du flux montant ====================

class UplinkReader:
    """Réassemble les trames montantes (73 / 27 octets) dans un flux bruité — §3.3.

    Resynchronisation sur ``0x55 0xAA``, taille attendue déduite du type
    (offset 2) ; en cas de CRC invalide, avancer d'un seul octet et
    recommencer — jamais sauter la trame d'un bloc. Tolère le log texte
    `[SERIAL]…` du mode USB-CDC (filtrage par en-têtes).
    """

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data: bytes) -> list[bytes]:
        """Ajoute des octets reçus ; retourne la liste des trames valides extraites."""
        self.buf.extend(data)
        frames: list[bytes] = []
        while True:
            idx = self.buf.find(b'\x55\xaa')
            if idx < 0:
                del self.buf[:-1]          # conserve au plus 1 octet (préfixe 0x55 possible)
                break
            del self.buf[:idx]
            if len(self.buf) < 3:
                break
            size = FRAME_SIZES.get(self.buf[2])
            if size is None:               # type inconnu : faux en-tête probable
                del self.buf[:1]
                continue
            if len(self.buf) < size:
                break
            frame = bytes(self.buf[:size])
            if (frame[size - 2] << 8 | frame[size - 1]) == crc16_ccitt(frame[2:size - 2]):
                frames.append(frame)
                del self.buf[:size]
            else:
                del self.buf[:1]           # CRC invalide : avancer d'un octet
        return frames
