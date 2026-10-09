# Built by `sam build`. Installs Linux arm64 wheels so it works from a Mac without Docker.
build-SaansFunction:
	python3 -m pip install -r requirements.txt -t "$(ARTIFACTS_DIR)" --platform manylinux2014_aarch64 --implementation cp --python-version 3.12 --only-binary=:all: --upgrade --quiet
	cp -r src/* "$(ARTIFACTS_DIR)"
