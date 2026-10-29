#!/usr/bin/env python3
"""Generate actual ONNX sentence-embedding model vectors for the fixed labeled corpus.

Usage: python3 scripts/prepare-related-embeddings.py
Dependencies: fastembed==0.9.1
This does not use synthetic or manually assigned semantic vectors.
"""
import json
import os
from pathlib import Path
from time import perf_counter

from fastembed import TextEmbedding

MODEL = os.getenv("DEVHUB_BENCHMARK_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
ROOT = Path(__file__).resolve().parent.parent
fixtures = json.loads((ROOT / "tests/fixtures/related-semantic.json").read_text())
if len(fixtures) != 26:
    raise ValueError("Semantic fixture corpus has changed without review")
sentences = [item["text"] for item in fixtures]
started = perf_counter()
model = TextEmbedding(model_name=MODEL, threads=2)
embeddings = [embedding.tolist() for embedding in model.embed(sentences, batch_size=16)]
if len(embeddings) != len(sentences):
    raise RuntimeError("Sentence embedder produced an incomplete batch")
# Exact model files and package version are recorded by the CI job log; the
# model name alone does not guarantee reproducible checkpoint identity.
record = {
    "provider": "fastembed-onnx",
    "model": MODEL,
    "modelRevision": os.getenv("DEVHUB_BENCHMARK_MODEL_REVISION", "model-revision-not-pinned"),
    "embeddingElapsedMs": (perf_counter() - started) * 1000,
    "vectors": embeddings,
}
output = ROOT / "reports/related-semantic-model-vectors.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(record))
print(json.dumps({
    "model": MODEL, "dimension": len(embeddings[0]),
    "count": len(embeddings), "embeddingElapsedMs": record["embeddingElapsedMs"],
    "artifact": str(output),
}))
