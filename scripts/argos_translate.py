import json
import contextlib
import logging
import sys


def main() -> int:
    output = sys.stdout
    try:
        payload = json.load(sys.stdin)
        text = str(payload.get("text", "")).strip()
        source = str(payload.get("source", "en") or "en")
        target = str(payload.get("target", "zh") or "zh")

        if not text:
            raise ValueError("No text provided.")

        logging.basicConfig(stream=sys.stderr, level=logging.ERROR, force=True)
        logging.disable(logging.WARNING)
        with contextlib.redirect_stdout(sys.stderr):
            from argostranslate import translate

            installed_languages = translate.get_installed_languages()
            from_language = next((lang for lang in installed_languages if lang.code == source), None)
            to_language = next((lang for lang in installed_languages if lang.code == target), None)

            if from_language is None or to_language is None:
                raise ValueError(f"Argos language package is not installed for {source}->{target}.")

            translation = from_language.get_translation(to_language)
            translated_text = translation.translate(text)
        print(json.dumps({"translatedText": translated_text}, ensure_ascii=False), file=output)
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=output)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
