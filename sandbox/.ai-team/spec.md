# Spec — Pakistani Number Plate OCR

## GOAL
A small Python tool that takes a photo of a Pakistani vehicle number plate and
returns the plate string as text (e.g. "LEA-1234"), with a confidence score.
Usable as a CLI and as a library function.

## CONSTRAINTS
- Python 3, offline. No cloud OCR APIs, no paid services.
- Runs on a normal laptop CPU. No GPU, no model training.
- Workspace: /home/ahmed/Desktop/ai-team/sandbox
- Tests included (pytest).

## DECISIONS
- 2026-08-22 (lead) Scope v1 to *recognition* of an already-cropped plate image.
  Plate detection in a full car photo is a separate, much larger job — deferred.
- 2026-08-22 (lead) Offline engine: Tesseract via pytesseract preferred;
  EasyOCR acceptable fallback if Tesseract is unavailable in this environment.
- 2026-08-22 (lead) No real sample images available, so tests use synthetically
  rendered plates. Real-world accuracy is therefore unproven until the user
  supplies photos.
- 2026-08-22 (lead) Plate format patterns live in one module (formats.py) so the
  researched, authoritative list can be dropped in without touching the pipeline.

## OPEN
- Q: Cropped plate or full car photo? Assumption: cropped plate (v1).
- Q: Real test images? Assumption: none; synthetic only.
- Q: Authoritative Pakistani plate formats per province? Assumption: first-cut
  patterns, to be replaced by R-01 findings.

## WORK
| ID   | who        | objective                                        | status |
|------|------------|--------------------------------------------------|--------|
| E-01 | Engineer   | Build the OCR pipeline, CLI, and test suite      | sent   |
| R-01 | Researcher | Authoritative Pakistani plate formats & charset  | sent   |
