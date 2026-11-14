// Package web holds the static files of the kvleva web interface so that
// they ship inside the binary.
package web

import (
	"embed"
	"io/fs"
)

//go:embed static
var static embed.FS

// Assets returns the files of the web interface, with index.html at the
// root.
func Assets() (fs.FS, error) {
	return fs.Sub(static, "static")
}
