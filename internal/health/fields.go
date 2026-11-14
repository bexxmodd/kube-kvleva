package health

import (
	"encoding/json"
	"strings"
)

// field walks nested maps and returns the value at path.
func field(obj map[string]any, path ...string) (any, bool) {
	var current any = obj
	for _, key := range path {
		m, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = m[key]
		if !ok {
			return nil, false
		}
	}
	return current, current != nil
}

// str returns the string at path, or "" when it is absent or not a string.
func str(obj map[string]any, path ...string) string {
	v, _ := field(obj, path...)
	s, _ := v.(string)
	return s
}

// integer returns the whole number at path. Decoders disagree on the Go type
// of JSON numbers, so every representation is accepted.
func integer(obj map[string]any, path ...string) (int64, bool) {
	v, ok := field(obj, path...)
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case int64:
		return n, true
	case int:
		return int64(n), true
	case int32:
		return int64(n), true
	case float64:
		return int64(n), true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	}
	return 0, false
}

// count returns the whole number at path, or 0 when it is absent.
func count(obj map[string]any, path ...string) int64 {
	n, _ := integer(obj, path...)
	return n
}

// list returns the list at path, or nil.
func list(obj map[string]any, path ...string) []any {
	v, _ := field(obj, path...)
	l, _ := v.([]any)
	return l
}

// dict returns v as a map, or nil when it is not one. Reading from the nil
// map is safe, which keeps callers free of type assertions.
func dict(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// apiGroup returns the API group of obj; the core group is "".
func apiGroup(obj map[string]any) string {
	group, _, hasGroup := strings.Cut(str(obj, "apiVersion"), "/")
	if !hasGroup {
		return ""
	}
	return group
}
