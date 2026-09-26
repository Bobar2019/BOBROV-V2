"""Routes des assets du Sub Simulator : bibliothèque et imports GLB.

Additif au socle (deux lignes dans ``app/main.py``, aucun autre contact) :
les modèles importés vivent sous ``static/sim/assets/importes/`` et sont
servis tels quels par le montage statique existant. La catégorie
« intégrés » liste les GLB livrés avec le module (``assets/models/``).

Upload en **corps brut** (pas de multipart, aucune dépendance nouvelle) :
le navigateur envoie l'octet-stream tel quel, le nom passe en paramètre
``name``. Bornes : ``.glb``/``.gltf`` uniquement, 50 Mo maximum, nom
nettoyé et anti-collision horodatée ; la suppression ne touche jamais aux
modèles intégrés.
"""
from __future__ import annotations

import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request

from app.config import PROJECT_ROOT

router = APIRouter(prefix="/api/sim/assets", tags=["sim-assets"])

MODELS_DIR = PROJECT_ROOT / "static" / "sim" / "assets" / "models"
IMPORTS_DIR = PROJECT_ROOT / "static" / "sim" / "assets" / "importes"
ALLOWED_SUFFIXES = (".glb", ".gltf")
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 Mo (limite du CDC Sub Simulator)

_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _sanitize_name(raw: str) -> str:
    """Nom de fichier sûr : basename, caractères restreints, extension imposée."""
    candidate = Path(raw).name.strip()
    candidate = _SAFE_NAME_RE.sub("_", candidate).lstrip("._") or "modele"
    if not candidate.lower().endswith(ALLOWED_SUFFIXES):
        raise HTTPException(status_code=415, detail="extension attendue : .glb ou .gltf")
    return candidate


def _unique_path(directory: Path, name: str) -> Path:
    """Anti-collision : suffixe horodaté si le nom est déjà utilisé."""
    target = directory / name
    if not target.exists():
        return target
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return directory / f"{target.stem}_{stamp}{target.suffix}"


def _entry(path: Path, source: str) -> dict:
    return {
        "file": path.name,
        "name": path.stem.replace("_", " ").strip() or path.name,
        "size": path.stat().st_size,
        "source": source,
        "url": f"/sim/assets/{'importes' if source == 'imported' else 'models'}/{path.name}",
    }


def _listing(directory: Path, source: str) -> list[dict]:
    if not directory.is_dir():
        return []
    entries = [_entry(path, source) for path in directory.iterdir()
               if path.is_file() and path.suffix.lower() in ALLOWED_SUFFIXES]
    return sorted(entries, key=lambda item: item["file"].lower())


@router.get("/models", summary="Bibliothèque des modèles (intégrés + importés)")
async def list_models() -> dict:
    """Catalogue consommé par la page de configuration du Sub Simulator."""
    return {
        "status": "ok",
        "models": _listing(MODELS_DIR, "integrated") + _listing(IMPORTS_DIR, "imported"),
    }


@router.post("/models", summary="Import d'un modèle GLB/GLTF (corps brut)")
async def upload_model(request: Request,
                       name: str = Query(..., min_length=1, max_length=200)) -> dict:
    """Écrit le corps de la requête sous ``importes/`` (nom nettoyé, ≤ 50 Mo)."""
    safe = _sanitize_name(name)
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="fichier trop volumineux (max 50 Mo)")
        except ValueError:
            raise HTTPException(status_code=400, detail="en-tête Content-Length invalide") from None

    IMPORTS_DIR.mkdir(parents=True, exist_ok=True)
    target = _unique_path(IMPORTS_DIR, safe)
    total = 0
    try:
        with target.open("wb") as handle:
            async for chunk in request.stream():
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="fichier trop volumineux (max 50 Mo)")
                handle.write(chunk)
    except HTTPException:
        target.unlink(missing_ok=True)
        raise
    except OSError as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"écriture impossible : {exc}") from exc

    if total == 0:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="corps de requête vide")
    return {"status": "ok", **_entry(target, "imported")}


@router.delete("/models/{filename}", summary="Suppression d'un modèle importé")
async def delete_model(filename: str) -> dict:
    """Supprime un fichier d'``importes/`` uniquement (jamais un intégré)."""
    if Path(filename).name != filename:
        raise HTTPException(status_code=400, detail="nom de fichier invalide")
    target = IMPORTS_DIR / filename
    if not target.is_file() or target.suffix.lower() not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=404, detail="modèle importé introuvable")
    try:
        target.unlink()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"suppression impossible : {exc}") from exc
    return {"status": "ok", "name": filename}
