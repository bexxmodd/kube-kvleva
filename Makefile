# kvleva development tasks. The shipped binary needs only Go to build; Node is
# used for the frontend tests alone.

BINARY := bin/kvleva
CONFIG ?= kvleva.example.yaml

.PHONY: build run test test-go test-web fmt vet clean

build:
	go build -o $(BINARY) ./cmd/kvleva

# Run against the cluster named in $(CONFIG) (the kind cluster "kvleva" by
# default) and serve http://127.0.0.1:8080.
run: build
	$(BINARY) -config $(CONFIG)

test: test-go test-web

test-go:
	go test -race ./...

test-web:
	cd web && npm test

fmt:
	gofmt -w cmd internal web/*.go

vet:
	go vet ./...

clean:
	rm -rf bin
