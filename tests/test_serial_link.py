"""Tests du service de liaison série (étape 3) — banc PTY + firmware simulé.

Le banc crée un pseudo-terminal : ``SerialLink`` ouvre le côté « RPi » (slave)
et un firmware BOB-CONTROL minimal joue l'ESP32-S3 sur le côté maître —
il répond à la synchronisation 0xFF par la rafale des noms (0x03/0x04),
puis émet de la télémétrie 0x02 à ~100 Hz et enregistre les commandes reçues.

Exécution : ``.venv/bin/python -m pytest tests/test_serial_link.py -v``
"""
from __future__ import annotations

import os
import pty
import select
import struct
import threading
import time
import tty

import pytest

from app.config import ConfigManager
from app.protocol import (
    UL_CFG_GPIO,
    UL_CFG_PWM,
    UL_TELEMETRY,
    crc16_ccitt,
)
from app.serial_link import SerialLink

TELEMETRY_PERIOD_S = 0.01  # firmware réel : télémétrie à 100 Hz (§5)


# ==================== Fabrique de trames montantes ====================

def _telemetry_frame(status: int = 0x02, gpio_state: int = 0x01) -> bytes:
    """Télémétrie 73 octets (vecteur §8.3, status/gpio paramétrables)."""
    payload = struct.pack(
        '<BB4h3h2i6H16HB',
        UL_TELEMETRY, status,
        10000, 0, 0, 0,                      # quaternion identité
        0, 0, 0,                             # gyro
        10132, 2500,                         # 1013,2 mbar / 25,00 °C
        5000, 800, 12000, 300, 14800, 23400,  # power
        *([1500] * 16),                      # pwm_actual
        gpio_state,
    )
    return b'\x55\xAA' + payload + struct.pack('>H', crc16_ccitt(payload))


def _config_frame(kind: int, ident: int, name: str) -> bytes:
    """Trame de configuration 27 octets (nom d'un canal PWM ou d'une sortie TOR)."""
    raw = name.encode('utf-8')
    payload = struct.pack('<BBB', kind, ident, len(raw)) + raw + bytes(20 - len(raw))
    return b'\x55\xAA' + payload + struct.pack('>H', crc16_ccitt(payload))


# ==================== Firmware simulé (côté maître du PTY) ====================

class FakeFirmware(threading.Thread):
    """BOB-CONTROL minimal : sync → rafale de noms + télémétrie 100 Hz, enregistre les commandes."""

    def __init__(self, master_fd: int):
        super().__init__(name="fake-firmware", daemon=True)
        self._master_fd = master_fd
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._buf = bytearray()
        self._commands: list[bytes] = []          # trames descendantes valides, dans l'ordre
        self._telemetry_active = False
        self._next_telemetry = 0.0

    def commands(self) -> list[bytes]:
        """Copie thread-safe des trames descendantes reçues."""
        with self._lock:
            return list(self._commands)

    def stop_and_join(self, timeout: float = 2.0) -> None:
        self._stop.set()
        self.join(timeout)

    def run(self) -> None:
        while not self._stop.is_set():
            try:
                ready, _, _ = select.select([self._master_fd], [], [], 0.002)
                if ready:
                    self._on_bytes(os.read(self._master_fd, 8192))
                if self._telemetry_active and time.monotonic() >= self._next_telemetry:
                    os.write(self._master_fd, _telemetry_frame())
                    self._next_telemetry += TELEMETRY_PERIOD_S
            except OSError:
                break                              # bout maître fermé : fin propre

    def _on_bytes(self, data: bytes) -> None:
        self._buf.extend(data)
        while True:
            idx = self._buf.find(b'\xAA\x55')
            if idx < 0:
                del self._buf[:-1]
                break
            del self._buf[:idx]
            if len(self._buf) < 40:
                break
            frame = bytes(self._buf[:40])
            if crc16_ccitt(frame[2:38]) != (frame[38] << 8 | frame[39]):
                del self._buf[:1]                  # CRC invalide : avancer d'un octet
                continue
            del self._buf[:40]
            with self._lock:
                self._commands.append(frame)
            if frame[2] == 0xFF:                   # synchronisation : démarre la session
                self._telemetry_active = True
                self._next_telemetry = time.monotonic() + TELEMETRY_PERIOD_S
                self._send_names()

    def _send_names(self) -> None:
        os.write(self._master_fd,
                 _config_frame(UL_CFG_PWM, 10, "Treuil arrière")
                 + _config_frame(UL_CFG_PWM, 11, "Treuil avant")
                 + _config_frame(UL_CFG_PWM, 12, "Pince")
                 + _config_frame(UL_CFG_GPIO, 1, "Lumière")
                 + _config_frame(UL_CFG_GPIO, 2, ""))  # name_len = 0 → libellé par défaut


# ==================== Banc de test ====================

class Bench:
    """PTY + firmware simulé + SerialLink piloté par une config.json isolée."""

    def __init__(self, tmp_path):
        self.config = ConfigManager(tmp_path / "config.json")
        self.config.load()
        self.config.update({"serial": {"reconnect_delay_s": 0.15}})
        self.link = SerialLink(config_manager=self.config)
        self._resources: list[tuple[int, int, FakeFirmware]] = []

    def plug(self) -> FakeFirmware:
        """Branche un câble USB simulé (PTY) avec un firmware au bout."""
        master_fd, slave_fd = pty.openpty()
        tty.setraw(master_fd)
        path = os.ttyname(slave_fd)
        sim = FakeFirmware(master_fd)
        sim.start()
        self._resources.append((master_fd, slave_fd, sim))
        self.config.update({"serial": {"port": path}})
        return sim

    def unplug(self, sim: FakeFirmware) -> None:
        """Débranche le câble : ferme les deux bouts du PTY (le thread doit survivre)."""
        for master_fd, slave_fd, candidate in list(self._resources):
            if candidate is sim:
                sim.stop_and_join()
                os.close(master_fd)
                os.close(slave_fd)
                self._resources.remove((master_fd, slave_fd, sim))
                return

    def close(self) -> None:
        self.link.stop()
        for master_fd, slave_fd, sim in list(self._resources):
            sim.stop_and_join()
            for fd in (master_fd, slave_fd):
                try:
                    os.close(fd)
                except OSError:
                    pass
        self._resources.clear()


def _wait_for(predicate, timeout: float = 3.0, interval: float = 0.02) -> bool:
    """Attend qu'un prédicat devienne vrai (tests asynchrones non flaky)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


@pytest.fixture()
def bench(tmp_path):
    bench = Bench(tmp_path)
    yield bench
    bench.close()


# ==================== Connexion, synchronisation, cadences ====================

def test_connect_sync_names_telemetry_and_cadences(bench):
    """Démarrage : sync 0xFF en première trame, rafale des noms, télémétrie, cadences TX/RX."""
    sim = bench.plug()
    bench.link.start()
    try:
        assert _wait_for(lambda: bench.link.get_status()["connected"])
        assert _wait_for(lambda: any(f[2] == 0x01 for f in sim.commands()))

        # La toute première trame descendante est la requête de synchronisation 0xFF.
        commands = sim.commands()
        assert commands[0][2] == 0xFF

        # Rafale des noms : personnalisés + libellé par défaut (name_len = 0).
        assert _wait_for(lambda: len(bench.link.get_status()["names_pwm"]) >= 3)
        status = bench.link.get_status()
        assert status["names_pwm"] == {"10": "Treuil arrière", "11": "Treuil avant", "12": "Pince"}
        assert status["names_gpio"] == {"1": "Lumière", "2": ""}

        # Télémétrie décodée, fraîche, bit « liaison établie » positionné par le firmware.
        assert _wait_for(lambda: bench.link.get_telemetry() is not None)
        telemetry = bench.link.get_telemetry()
        assert telemetry["armed"] is True
        assert telemetry["pressure_mbar"] == 1013.2
        assert telemetry["temperature_c"] == 25.0
        assert telemetry["pwm_us"] == [1500] * 16
        assert telemetry["gpio_state"] == 0x01
        assert telemetry["age_s"] < 1.0

        # Cadences mesurées sur ~1 s : TX cible 25 Hz, firmware simulé ~100 Hz en RX.
        before = bench.link.get_status()
        time.sleep(1.0)
        after = bench.link.get_status()
        tx_hz = after["tx_frames"] - before["tx_frames"]
        rx_hz = after["rx_frames"] - before["rx_frames"]
        assert 18 <= tx_hz <= 32, f"cadence TX hors tolérance : {tx_hz} trames/s"
        assert 50 <= rx_hz <= 140, f"cadence RX hors tolérance : {rx_hz} trames/s"
    finally:
        bench.link.stop()
    assert bench.link.get_status()["thread_alive"] is False


# ==================== Commandes (thread-safety) ====================

def test_set_command_reaches_the_firmware(bench):
    """set_command → trame 0x01 reflétant mode/armement/PWM/GPIO, avec émission immédiate."""
    sim = bench.plug()
    bench.link.start()
    try:
        assert _wait_for(lambda: bench.link.get_status()["connected"])
        assert _wait_for(lambda: any(f[2] == 0x01 for f in sim.commands()))

        started = time.monotonic()
        bench.link.set_command(pwm_us=[1600] + [1450] * 15, gpio_cmd=0x05, mode=0x03, arm_state=1)

        def _armed_frames():
            return [f for f in sim.commands() if f[2] == 0x01 and f[3] == 0x03 and f[4] == 1]

        assert _wait_for(lambda: _armed_frames(), 1.0)
        latency = time.monotonic() - started
        assert latency < 0.2, f"émission immédiate attendue (< 200 ms), mesurée {latency * 1000:.0f} ms"

        frame = _armed_frames()[-1]
        assert frame[5:7] == (1600).to_bytes(2, "little")   # pwm[0] little-endian
        assert frame[7:9] == (1450).to_bytes(2, "little")   # pwm[1]
        assert frame[37] == 0x05                            # gpio_cmd

        # Validation stricte : toute valeur rejetée laisse la commande courante intacte.
        for bad in (
            dict(pwm_us=[1500] * 15),
            dict(pwm_us=[999] + [1500] * 15),
            dict(pwm_us=[2001] + [1500] * 15),
            dict(gpio_cmd=16),
            dict(mode=16),
            dict(arm_state=3),
        ):
            with pytest.raises(ValueError):
                bench.link.set_command(**bad)
        command = bench.link.get_status()["command"]
        assert command["mode"] == 0x03
        assert command["arm_state"] == 1
        assert command["pwm_us"] == [1600] + [1450] * 15
        assert command["gpio_cmd"] == 0x05
    finally:
        bench.link.stop()


# ==================== Résilience ====================

def test_cable_unplugged_then_replugged_on_new_port(bench):
    """Débranchement : thread vivant + reconnexion automatique sur un nouveau port."""
    sim1 = bench.plug()
    bench.link.start()
    try:
        assert _wait_for(lambda: bench.link.get_status()["connected"])
        assert _wait_for(lambda: bench.link.get_telemetry() is not None)

        bench.unplug(sim1)                                     # câble USB débranché
        assert _wait_for(lambda: not bench.link.get_status()["connected"])
        assert bench.link.get_status()["thread_alive"] is True  # le thread n'est jamais mort
        assert bench.link.get_status()["last_error"]            # l'incident est tracé

        sim2 = bench.plug()                                     # rebranché sur un autre port
        assert _wait_for(lambda: bench.link.get_status()["connected"], 6.0)
        assert _wait_for(lambda: sim2.commands() and sim2.commands()[0][2] == 0xFF, 3.0)
        assert _wait_for(
            lambda: (t := bench.link.get_telemetry()) is not None and t["age_s"] < 1.0)
    finally:
        bench.link.stop()
    assert bench.link.get_status()["thread_alive"] is False


def test_missing_port_keeps_thread_alive(bench):
    """Port introuvable (UART non activé, mauvais chemin…) : thread vivant, erreur tracée."""
    bench.config.update({"serial": {"port": "/dev/ttyBOBROV-ABSENT"}})
    bench.link.start()
    try:
        assert _wait_for(lambda: bench.link.get_status()["last_error"] is not None)
        status = bench.link.get_status()
        assert status["connected"] is False
        assert status["thread_alive"] is True       # le thread survit et retente indéfiniment
    finally:
        bench.link.stop()
    assert bench.link.get_status()["thread_alive"] is False
