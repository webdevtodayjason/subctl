# bin/subctl-policy-check/Makefile
#
# Build targets for the Go-compiled policy hot path. The host build (`make`)
# is what install.sh runs; the cross-compile target (`make build-all`) is for
# producing release binaries.
#
# Per pack 12 §2 (PR 8 acceptance criteria): binary must compile on macOS arm64
# and Linux amd64. We add the other two combos as a bonus.

BINARY := subctl-policy-check
PLATFORMS := darwin/amd64 darwin/arm64 linux/amd64 linux/arm64

.PHONY: build build-all test clean install fmt vet

build:
	go build -trimpath -ldflags="-s -w" -o $(BINARY) .

build-all:
	@for p in $(PLATFORMS); do \
		os=$$(echo $$p | cut -d/ -f1); \
		arch=$$(echo $$p | cut -d/ -f2); \
		out=$(BINARY)-$$os-$$arch; \
		echo "==> $$out"; \
		GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags="-s -w" -o $$out . || exit 1; \
	done

test:
	go test -v ./...

fmt:
	go fmt ./...

vet:
	go vet ./...

clean:
	rm -f $(BINARY) $(BINARY)-*

# Dev-workflow convenience. install.sh is the production placer; this rule
# just drops the host build next to the main subctl on the operator's machine.
install: build
	@if [ -d $$HOME/.subctl/bin ]; then \
		cp $(BINARY) $$HOME/.subctl/bin/$(BINARY); \
		echo "installed to $$HOME/.subctl/bin/$(BINARY)"; \
	else \
		echo "skipping install: $$HOME/.subctl/bin not present (run install.sh first)"; \
	fi
