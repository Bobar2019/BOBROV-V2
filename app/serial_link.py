"""Liaison série temps réel RPi 5 ↔ ESP32-S3 — thread dédié, hautement résilient.

Liaison : 921600 bauds 8N1. UART natif GPIO 14/15 → « /dev/serial0 »
(alias udev stable : ttyAMA10 sur Pi 5, ttyAMA0 sur Pi 4/3) ; alternative
USB-CDC : « /dev/ttyACM0 » — le port vient de config.json → serial.port.
Aucun contrôle de flux matériel (les lignes modem n'existent pas en UART GPIO).

Architecture (PROTOCOLE_RPI5.md §6) :
- UN thread `bobrov-serial` isole les E/S série de la boucle asyncio de FastAPI
  (aucune concurrence sur le port, cadences garanties) ;
- TX : la commande courante est émise à cadence fixe (config.json → serial.tx_hz,
  25 Hz par défaut) calée sur ``time.monotonic`` — chaque trame nourrit le
  watchdog firmware de 500 ms (§6.1) et entretient la maîtrise du RPi 5 (§6.3).
  Tout changement d'armement ou de mode déclenche en plus une émission immédiate ;
- RX : lecture non bloquante, réassemblage ``UplinkReader`` (étape 2) et
  dispatch télémétrie 0x02 / noms personnalisés 0x03-0x04 ;
- à l'ouverture du port : purge, requête de synchronisation 0xFF (§4.4) puis
  attente de la rafale des noms (§5.6) — sans jamais bloquer la boucle ;
- reconnexion infinie : tout échec (câble débranché, redémarrage firmware §6.5,
  port absent…) ferme la session, se journalise, puis retente après
  ``serial.reconnect_delay_s`` en relisant config.json — le thread ne meurt
  jamais, FastAPI non plus.

Interface thread-safe pour le reste du cockpit :
- ``set_command()``   : écrit la commande courante (validation stricte) ;
- ``get_telemetry()`` : dernière télémétrie décodée + âge de fraîcheur ;
- ``get_status()``    : état complet de la liaison (connexion, compteurs, noms).
"""
from __future__ import annotations

import logging
import os
import threading
import time

import serial

from app.config import ConfigManager, get_config
from app.protocol import (
    ARM_DISARMED,
    MODE_PASSIF,
    UL_CFG_GPIO,
    UL_CFG_PWM,
    UL_TELEMETRY,
    UplinkReader,
    build_downlink_frame,
    build_sync_request,
    parse_config_frame,
    parse_uplink_frame,
)

log = logging.getLogger("bobrov.serial")

# Bornes de sécurité cockpit (le firmware borne aussi — double garde).
PWM_CHANNELS = 16
PWM_MIN_US, PWM_MAX_US = 1000, 2000

# Constantes internes
_SESSION_REPORT_S = 5.0          # périodicité du log de cadences mesurées
_NAMES_BURST_TIMEOUT_S = 2.0     # attente max de la rafale des noms après la sync
_NAMES_BURST_END_S = 0.3         # silence de cette durée ⇒ rafale terminée
_POLL_SLEEP_S = 0.0005           # veille de boucle (latence RX ≤ 1 ms)


class SerialLink:
    """Service de liaison série (thread dédié) — instance unique ``SERIAL_LINK``."""

    def __init__(self, config_manager: ConfigManager | None = None):
        self._config = config_manager or get_config()
        self._lock = threading.RLock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

        # --- Commande courante : écrite par FastAPI, lue par la boucle TX ---
        self._mode = MODE_PASSIF
        self._arm_state = ARM_DISARMED                      # sécurité : neutre désarmé au départ
        self._pwm_us = [1500] * PWM_CHANNELS
        self._gpio_cmd = 0
        self._force_tx = True                               # première trame aussitôt connecté

        # --- État de la liaison : écrit par le thread, lu par FastAPI ---
        self._connected = False
        self._port: str | None = None
        self._baud: int | None = None
        self._tx_hz: float | None = None
        self._last_error: str | None = None
        self._last_telemetry: dict | None = None
        self._last_telemetry_at: float | None = None
        self._tx_count = 0
        self._rx_count = 0
        self._names_pwm: dict[int, str] = {}
        self._names_gpio: dict[int, str] = {}

    # ------------------------------------------------------------------
    # Cycle de vie
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Lance le thread de liaison (idempotent)."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="bobrov-serial", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 3.0) -> None:
        """Arrête le thread proprement (le port est fermé par la boucle elle-même)."""
        self._stop_event.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout)
            if thread.is_alive():
                log.warning("thread série toujours actif après %.1f s — abandon du join", timeout)
            else:
                log.info("thread de liaison série arrêté")
            self._thread = None

    # ------------------------------------------------------------------
    # Interface thread-safe pour FastAPI (étapes 4+)
    # ------------------------------------------------------------------

    def set_command(self, pwm_us=None, gpio_cmd=None, mode=None, arm_state=None) -> None:
        """Met à jour la commande courante (seuls les arguments fournis changent).

        Validation stricte : ``pwm_us`` = 16 voies dans [1000, 2000] µs,
        ``gpio_cmd``/``mode`` dans [0, 15], ``arm_state`` dans {0, 1, 2} ;
        toute valeur invalide ⇒ ``ValueError`` sans modification de la commande.
        Un changement d'``arm_state`` ou de ``mode`` déclenche l'émission
        immédiate de la trame suivante (§4).
        """
        with self._lock:
            new_pwm, new_gpio = self._pwm_us, self._gpio_cmd
            new_mode, new_arm = self._mode, self._arm_state

            if pwm_us is not None:
                values = [int(v) for v in pwm_us]
                if len(values) != PWM_CHANNELS:
                    raise ValueError(f"pwm_us : {PWM_CHANNELS} voies attendues, {len(values)} reçues")
                for value in values:
                    if not PWM_MIN_US <= value <= PWM_MAX_US:
                        raise ValueError(f"pwm_us : {value} µs hors bornes [{PWM_MIN_US}, {PWM_MAX_US}]")
                new_pwm = values
            if gpio_cmd is not None:
                new_gpio = int(gpio_cmd)
                if not 0 <= new_gpio <= 0x0F:
                    raise ValueError(f"gpio_cmd : {new_gpio} hors masque 4 bits [0, 15]")
            if mode is not None:
                new_mode = int(mode)
                if not 0 <= new_mode <= 0x0F:
                    raise ValueError(f"mode : {new_mode} hors masque 4 bits [0, 15]")
            if arm_state is not None:
                new_arm = int(arm_state)
                if new_arm not in (0, 1, 2):
                    raise ValueError(f"arm_state : {new_arm} invalide (0 = désarmé, 1 = armé, 2 = E-Stop)")

            if new_mode != self._mode or new_arm != self._arm_state:
                self._force_tx = True                           # émission immédiate (§4)
            self._pwm_us, self._gpio_cmd = new_pwm, new_gpio
            self._mode, self._arm_state = new_mode, new_arm

    def get_telemetry(self) -> dict | None:
        """Dernière télémétrie décodée (copie) enrichie de ``age_s`` ; None si jamais reçue."""
        with self._lock:
            if self._last_telemetry is None:
                return None
            telemetry = dict(self._last_telemetry)
            telemetry["age_s"] = round(time.monotonic() - self._last_telemetry_at, 3)
            return telemetry

    def get_status(self) -> dict:
        """État complet de la liaison (thread-safe) — consommé par /api/system/status."""
        with self._lock:
            return {
                "thread_alive": bool(self._thread and self._thread.is_alive()),
                "connected": self._connected,
                "port": self._port,
                "baud": self._baud,
                "tx_hz_target": self._tx_hz,
                "tx_frames": self._tx_count,
                "rx_frames": self._rx_count,
                "names_pwm": {str(k): v for k, v in sorted(self._names_pwm.items())},
                "names_gpio": {str(k): v for k, v in sorted(self._names_gpio.items())},
                "last_error": self._last_error,
                "command": {
                    "mode": self._mode,
                    "arm_state": self._arm_state,
                    "pwm_us": list(self._pwm_us),
                    "gpio_cmd": self._gpio_cmd,
                },
            }

    # ------------------------------------------------------------------
    # Thread : boucle de reconnexion infinie
    # ------------------------------------------------------------------

    def _run(self) -> None:
        log.info("thread de liaison série démarré — boucle de connexion en attente")
        while not self._stop_event.is_set():
            try:
                cfg = self._config.get_section("serial")
                port, baud = str(cfg["port"]), int(cfg["baud"])
                tx_hz, delay = float(cfg["tx_hz"]), float(cfg["reconnect_delay_s"])
            except Exception as exc:                            # config illisible : on insiste
                log.error("config.json illisible (%s) — nouvel essai dans 2 s", exc)
                self._stop_event.wait(2.0)
                continue

            with self._lock:
                self._port, self._baud, self._tx_hz = port, baud, tx_hz

            ser = None
            try:
                log.info("connexion : ouverture de %s @ %d bauds 8N1 (TX cible %.1f Hz)…", port, baud, tx_hz)
                ser = serial.Serial(
                    port=port, baudrate=baud,
                    bytesize=serial.EIGHTBITS,          # 8N1 explicite — identique USART GPIO et USB-CDC
                    parity=serial.PARITY_NONE,
                    stopbits=serial.STOPBITS_ONE,
                    timeout=0,                          # lectures non bloquantes
                    write_timeout=0.5,
                    xonxoff=False, rtscts=False,        # UART GPIO : pas de contrôle de flux
                )
                self._mark_connected(port, baud)
                log.info("port %s ouvert — synchronisation en cours", port)
                self._run_session(ser, tx_hz)
            except (serial.SerialException, OSError) as exc:
                self._mark_disconnected(str(exc))
                if os.path.exists(port):
                    log.warning("liaison série perdue : %s", exc)
                else:
                    log.warning("port %s introuvable (%s) — UART GPIO : activer avec « enable_uart=1 » "
                                "(raspi-config) et désactiver serial-getty@%s",
                                port, exc, os.path.basename(port))
            except Exception as exc:                            # garde-fou : jamais de crash
                self._mark_disconnected(repr(exc))
                log.exception("erreur inattendue dans la boucle série : %s", exc)
            finally:
                if ser is not None:
                    try:
                        ser.close()
                    except Exception:
                        pass
                self._mark_disconnected()

            if not self._stop_event.is_set():
                log.info("reconnexion dans %.1f s…", delay)
                self._stop_event.wait(delay)

        self._mark_disconnected()
        log.info("thread de liaison série terminé")

    def _run_session(self, ser: serial.Serial, tx_hz: float) -> None:
        """Une session de liaison : sync 0xFF → boucles TX/RX jusqu'à l'erreur."""
        reader = UplinkReader()

        # Purge des résidus de la session précédente, puis synchronisation (§4.4).
        ser.reset_input_buffer()
        ser.write(build_sync_request())
        log.info("synchronisation 0xFF envoyée — attente de la rafale des noms personnalisés…")

        with self._lock:
            self._force_tx = True                               # la 1re commande suit la sync

        period = 1.0 / tx_hz
        next_tx = time.monotonic()
        window_start = time.monotonic()
        tx_window = rx_window = 0
        names_state = "waiting"                                 # waiting → receiving → done|timeout
        names_deadline = time.monotonic() + _NAMES_BURST_TIMEOUT_S
        names_last_seen = 0.0

        while not self._stop_event.is_set():
            now = time.monotonic()

            # ---------------- TX : cadence stricte + émission immédiate -----
            with self._lock:
                if self._force_tx or now >= next_tx:
                    frame = build_downlink_frame(self._mode, self._arm_state,
                                                 self._pwm_us, self._gpio_cmd)
                    self._force_tx = False
                    send = True
                else:
                    send = False
            if send:
                ser.write(frame)
                with self._lock:
                    self._tx_count += 1
                tx_window += 1
                next_tx += period
                if next_tx <= now:                              # retard : recaler sans rafale
                    next_tx = now + period

            # ---------------- RX : lecture non bloquante + parsing ----------
            chunk = ser.read(4096)
            if chunk:
                for uplink in reader.feed(chunk):
                    kind = self._dispatch(uplink)
                    rx_window += 1
                    if kind != UL_TELEMETRY:
                        names_last_seen = now
                        if names_state == "waiting":
                            names_state = "receiving"

            # ---------------- Suivi de la rafale des noms -------------------
            if names_state == "waiting" and now >= names_deadline:
                names_state = "timeout"
                log.warning("aucune trame de nom (0x03/0x04) %.0f s après la sync — non bloquant",
                            _NAMES_BURST_TIMEOUT_S)
            elif names_state == "receiving" and now - names_last_seen >= _NAMES_BURST_END_S:
                names_state = "done"
                with self._lock:
                    nb_pwm, nb_gpio = len(self._names_pwm), len(self._names_gpio)
                log.info("rafale des noms reçue : %d canaux PWM + %d sorties TOR personnalisés",
                         nb_pwm, nb_gpio)

            # ---------------- Log périodique des cadences mesurées ----------
            if now - window_start >= _SESSION_REPORT_S:
                elapsed = now - window_start
                with self._lock:
                    tx_total, rx_total = self._tx_count, self._rx_count
                log.info("cadences mesurées : TX %.1f Hz (cible %.1f) | RX %.1f Hz | cumul TX %d / RX %d",
                         tx_window / elapsed, tx_hz, rx_window / elapsed, tx_total, rx_total)
                tx_window = rx_window = 0
                window_start = now
                try:                                            # prise en compte à chaud
                    tx_hz = float(self._config.get_section("serial")["tx_hz"])
                    period = 1.0 / tx_hz
                except Exception:
                    pass

            self._stop_event.wait(_POLL_SLEEP_S)

    # ------------------------------------------------------------------
    # Interne
    # ------------------------------------------------------------------

    def _dispatch(self, frame: bytes) -> int:
        """Range une trame montante déjà validée (taille + CRC) par l'UplinkReader."""
        kind = frame[2]
        try:
            if kind == UL_TELEMETRY:
                telemetry = parse_uplink_frame(frame)
                with self._lock:
                    self._last_telemetry = telemetry
                    self._last_telemetry_at = time.monotonic()
            else:                                               # 0x03 / 0x04 : noms
                info = parse_config_frame(frame)
                with self._lock:
                    target = self._names_pwm if info["kind"] == "pwm" else self._names_gpio
                    target[info["id"]] = info["name"]
            with self._lock:
                self._rx_count += 1
        except ValueError as exc:                               # ne devrait jamais arriver
            log.warning("trame montante non décodable : %s", exc)
        return kind

    def _mark_connected(self, port: str, baud: int) -> None:
        with self._lock:
            self._connected = True
            self._port, self._baud = port, baud
            self._last_error = None

    def _mark_disconnected(self, error: str | None = None) -> None:
        with self._lock:
            self._connected = False
            if error:
                self._last_error = error


# Instance unique partagée par l'application (démarrée/arrêtée par le lifespan).
SERIAL_LINK = SerialLink()


def get_serial_link() -> SerialLink:
    """Accès au service de liaison série global."""
    return SERIAL_LINK
