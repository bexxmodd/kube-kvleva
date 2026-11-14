package web

import (
	"io/fs"
	"regexp"
	"testing"
)

func TestAssetsServeTheWebInterface(t *testing.T) {
	assets, err := Assets()
	if err != nil {
		t.Fatalf("Assets() failed: %v", err)
	}
	page, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		t.Fatalf("Assets() has no index.html at its root: %v", err)
	}

	// Every script and stylesheet the page loads must be embedded too,
	// otherwise the page would come up broken.
	references := regexp.MustCompile(`(?:src|href)="([^"]+\.(?:js|css))"`).FindAllSubmatch(page, -1)
	if len(references) == 0 {
		t.Fatalf("index.html loads no script or stylesheet:\n%s", page)
	}
	for _, reference := range references {
		name := string(reference[1])
		if _, err := fs.Stat(assets, name); err != nil {
			t.Errorf("index.html loads %q, which is not embedded: %v", name, err)
		}
	}
}

func TestAssetsExcludeDevelopmentFiles(t *testing.T) {
	assets, err := Assets()
	if err != nil {
		t.Fatalf("Assets() failed: %v", err)
	}
	for _, name := range []string{"package.json", "node_modules", "test"} {
		if _, err := fs.Stat(assets, name); err == nil {
			t.Errorf("Assets() contains %q, which is not part of the web interface", name)
		}
	}
}
