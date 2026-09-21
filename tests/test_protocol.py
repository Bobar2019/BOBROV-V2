"""Tests du module protocole (étape 2) — vecteurs normatifs PROTOCOLE_RPI5.md §8.

Ces tests valident le parseur contre les trames de référence du firmware
BOB-CONTROL (v1.5.0) : toute rupture ici signale une non-conformité binaire.

Exécution : ``.venv/bin/python -m pytest tests/test_protocol.py -v``
"""
from __future__ import annotations

import pytest

from app.protocol import (
    ARM_ARMED,
    MODE_DEPTH,
    MODE_RT,
    UL_CFG_PWM,
    UL_TELEMETRY,
    UplinkReader,
    build_downlink_frame,
    build_sync_request,
    crc16_ccitt,
    parse_config_frame,
    parse_uplink_frame,
)

# ==================== Vecteurs normatifs (§8) ====================

# §8.3 — télémétrie de référence : status 0x12 (liaison établie + dry-run),
# quaternion identité, 1013,2 mbar, 25,00 °C, pwm[0] = 1600 µs,
# gpio_state 0x05 (sorties 1 et 3 à ON), CRC 0xB301.
UL_REFERENCE = bytes.fromhex(
    '55 AA 02 12 10 27 00 00 00 00 00 00 00 00 00 00'
    '00 00 94 27 00 00 C4 09 00 00 88 13 20 03 E0 2E'
    '2C 01 D0 39 68 5B 40 06 DC 05 DC 05 DC 05 DC 05'
    'DC 05 DC 05 DC 05 DC 05 DC 05 DC 05 DC 05 DC 05'
    'DC 05 DC 05 DC 05 05 B3 01'
)

# §8.5 — canal PWM 11, « Treuil avant » (name_len = 0x0C = 12), CRC 0x3854.
CFG_PWM_REFERENCE = bytes.fromhex(
    '55 AA 03 0B 0C 54 72 65 75 69 6C 20 61 76 61 6E'
    '74 00 00 00 00 00 00 00 00 38 54'
)

# §8.6 — sortie TOR 2 sans nom personnalisé (name_len = 0), CRC 0x99EB.
CFG_GPIO_REFERENCE = bytes.fromhex(
    '55 AA 04 02 00 00 00 00 00 00 00 00 00 00 00 00'
    '00 00 00 00 00 00 00 00 00 99 EB'
)

# Bruit de test : ASCII pur (aucun octet 0xAA possible ⇒ jamais de faux en-tête).
NOISE = b'\n[SERIAL] boot ok\r\n[SENSORS] bno085 ok\r\n'

# Faux en-tête injecté au milieu du flux (§8.4).
FAKE_HEADER = bytes.fromhex('55 AA 02 00')


# ==================== §8.1 — valeur de contrôle CRC ====================

def test_crc16_control_value():
    assert crc16_ccitt(b'123456789') == 0x29B1


# ==================== §8.2 — trame descendante de référence ====================

def test_downlink_reference_frame():
    """MODE_PASSIF + ARM_ARMED + 16 voies à 1500 µs + gpio_cmd 0x05."""
    expected = bytes.fromhex(
        'AA 55 01 00 01 DC 05 DC 05 DC 05 DC 05 DC 05 DC 05 DC 05 DC 05'
        'DC 05 DC 05 DC 05 DC 05 DC 05 DC 05 DC 05 DC 05 05 30 72'
    )
    frame = build_downlink_frame(0, 1, [1500] * 16, 0x05)
    assert frame == expected
    assert len(frame) == 40
    assert frame.hex() == 'aa55010001' + 'dc05' * 16 + '05' + '3072'


def test_downlink_frame_layout():
    """§4 — mode (offset 3), armement (4), pwm little-endian (5 + 2k), gpio (37), CRC BE (38-39)."""
    frame = build_downlink_frame(MODE_RT | MODE_DEPTH, ARM_ARMED, [1200] + [1500] * 15, 0x00)
    assert frame[0:2] == b'\xAA\x55'
    assert frame[2] == 0x01
    assert frame[3] == 0x03                     # masque superposé : Auto R/T + tenue de profondeur
    assert frame[4] == ARM_ARMED
    assert frame[5:7] == b'\xB0\x04'            # 1200 = 0x04B0, octet faible d'abord
    assert frame[35:37] == b'\xDC\x05'          # pwm[15] = 1500
    assert frame[37] == 0x00                    # gpio_cmd
    assert (frame[38] << 8 | frame[39]) == crc16_ccitt(frame[2:38])


# ==================== §8.7 — requête de synchronisation ====================

def test_sync_request_reference_frame():
    """Type 0xFF, contenu à zéro, CRC 0xCA33 (big-endian)."""
    frame = build_sync_request()
    assert len(frame) == 40
    assert frame.hex() == 'aa55ff' + '00' * 35 + 'ca33'
    assert frame[2] == 0xFF
    assert frame[3:38] == bytes(35)             # contenu ignoré par le firmware


# ==================== §8.3 — trame montante de référence ====================

def test_uplink_reference_decoding():
    telemetry = parse_uplink_frame(UL_REFERENCE)
    assert telemetry['status'] == 0x12
    assert telemetry['armed'] is True           # liaison établie (bit 0x02)
    assert telemetry['watchdog'] is False
    assert telemetry['dry_run'] is True
    assert telemetry['auto_rt'] is False
    assert telemetry['depth_hold'] is False
    assert telemetry['cap_hold'] is False
    assert telemetry['surface'] is False
    assert telemetry['quat'] == (1.0, 0.0, 0.0, 0.0)
    assert telemetry['gyro'] == (0.0, 0.0, 0.0)
    assert telemetry['pressure_mbar'] == 1013.2
    assert telemetry['temperature_c'] == 25.0
    assert telemetry['power'] == [5000, 800, 12000, 300, 14800, 23400]
    assert telemetry['pwm_us'] == [1600] + [1500] * 15
    assert telemetry['gpio_state'] == 0x05


# ==================== §8.4 — robustesse du réassemblage ====================

def test_uplink_reader_resync_with_split_frame_and_fake_header():
    """Bruit + moitié de trame, puis moitié + faux en-tête + trame + bruit ⇒ 2 trames."""
    reader = UplinkReader()
    half = len(UL_REFERENCE) // 2
    assert reader.feed(NOISE + UL_REFERENCE[:half]) == []
    frames = reader.feed(UL_REFERENCE[half:] + FAKE_HEADER + UL_REFERENCE + NOISE)
    assert len(frames) == 2
    assert all(frame == UL_REFERENCE for frame in frames)


def test_uplink_reader_mixed_telemetry_and_config_burst():
    """Trame 0x03 intercalée entre deux télémétries ⇒ 3 trames valides (2× 0x02 + 1× 0x03)."""
    reader = UplinkReader()
    frames = reader.feed(UL_REFERENCE + CFG_PWM_REFERENCE + UL_REFERENCE)
    assert [frame[2] for frame in frames] == [UL_TELEMETRY, UL_CFG_PWM, UL_TELEMETRY]
    assert frames[0] == frames[2] == UL_REFERENCE
    assert parse_config_frame(frames[1]) == {
        'kind': 'pwm', 'id': 11, 'name': 'Treuil avant', 'default_name': False,
    }


def test_uplink_reader_skips_corrupted_frame():
    """CRC invalide ⇒ avancer d'un octet et retrouver la trame suivante intacte (§3.3)."""
    corrupted = bytearray(UL_REFERENCE)
    corrupted[10] ^= 0xFF
    reader = UplinkReader()
    frames = reader.feed(bytes(corrupted) + UL_REFERENCE)
    assert frames == [UL_REFERENCE]


# ==================== §8.5 / §8.6 — trames de configuration des noms ====================

def test_config_pwm_reference_frame():
    """Canal 11 « Treuil avant » (name_len = 12)."""
    assert CFG_PWM_REFERENCE.hex() == '55aa030b0c' + '54726575696c206176616e74' + '00' * 8 + '3854'
    assert parse_config_frame(CFG_PWM_REFERENCE) == {
        'kind': 'pwm', 'id': 11, 'name': 'Treuil avant', 'default_name': False,
    }


def test_config_gpio_reference_frame():
    """Sortie 2 sans nom personnalisé (name_len = 0 ⇒ libellé par défaut côté cockpit)."""
    assert CFG_GPIO_REFERENCE.hex() == '55aa0402' + '00' * 21 + '99eb'
    assert parse_config_frame(CFG_GPIO_REFERENCE) == {
        'kind': 'gpio', 'id': 2, 'name': '', 'default_name': True,
    }


def test_config_rejects_name_len_over_20():
    """§5.6 — name_len valide : 0–20 (ici 21, CRC valide, ⇒ rejeté)."""
    payload = bytes((UL_CFG_PWM, 11, 21)) + b'A' * 20
    frame = b'\x55\xAA' + payload + crc16_ccitt(payload).to_bytes(2, 'big')
    assert len(frame) == 27
    with pytest.raises(ValueError, match='name_len'):
        parse_config_frame(frame)


# ==================== Garde-fous de validation (hors §8) ====================

def test_uplink_rejects_wrong_size_header_and_crc():
    with pytest.raises(ValueError):
        parse_uplink_frame(UL_REFERENCE[:-1])       # 72 octets
    bad_header = bytearray(UL_REFERENCE)
    bad_header[0] = 0x54
    with pytest.raises(ValueError):
        parse_uplink_frame(bytes(bad_header))
    bad_crc = bytearray(UL_REFERENCE)
    bad_crc[69] ^= 0xFF
    with pytest.raises(ValueError, match='CRC16'):
        parse_uplink_frame(bytes(bad_crc))


def test_config_rejects_wrong_size_and_crc():
    with pytest.raises(ValueError):
        parse_config_frame(CFG_PWM_REFERENCE[:-1])  # 26 octets
    bad_crc = bytearray(CFG_PWM_REFERENCE)
    bad_crc[5] ^= 0x20                              # altère le nom, CRC inchangé
    with pytest.raises(ValueError, match='CRC16'):
        parse_config_frame(bytes(bad_crc))
