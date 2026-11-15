package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestLoadWithoutFileUsesSafeDefaults(t *testing.T) {
	got, err := Load("")
	if err != nil {
		t.Fatalf("Load(%q) failed: %v", "", err)
	}
	want := Config{
		Listen: Listen{Address: "127.0.0.1", Port: 8080},
		Resources: Resources{Exclude: []string{
			"events",
			"events.events.k8s.io",
			"leases.coordination.k8s.io",
			"endpoints",
		}},
		Logs: Logs{Enabled: true},
	}
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Load(%q) diff (-want +got):\n%s", "", diff)
	}
}

func TestParse(t *testing.T) {
	tests := []struct {
		name string
		yaml string
		want Config
	}{
		{
			name: "empty_document_is_defaults",
			yaml: "",
			want: Default(),
		},
		{
			name: "cluster_context",
			yaml: "cluster:\n  context: kind-kvleva\n",
			want: func() Config {
				c := Default()
				c.Cluster.Context = "kind-kvleva"
				return c
			}(),
		},
		{
			name: "kubeconfig_path",
			yaml: "cluster:\n  kubeconfig: /tmp/kubeconfig\n",
			want: func() Config {
				c := Default()
				c.Cluster.Kubeconfig = "/tmp/kubeconfig"
				return c
			}(),
		},
		{
			name: "port",
			yaml: "listen:\n  port: 9090\n",
			want: func() Config {
				c := Default()
				c.Listen.Port = 9090
				return c
			}(),
		},
		{
			name: "exclude_replaces_defaults",
			yaml: "resources:\n  exclude:\n    - secrets\n",
			want: func() Config {
				c := Default()
				c.Resources.Exclude = []string{"secrets"}
				return c
			}(),
		},
		{
			name: "empty_exclude_loads_everything",
			yaml: "resources:\n  exclude: []\n",
			want: func() Config {
				c := Default()
				c.Resources.Exclude = []string{}
				return c
			}(),
		},
		{
			name: "logs_switched_off",
			yaml: "logs:\n  enabled: false\n",
			want: func() Config {
				c := Default()
				c.Logs.Enabled = false
				return c
			}(),
		},
		{
			name: "empty_logs_section_keeps_logs_on",
			yaml: "logs: {}\n",
			want: Default(),
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Parse([]byte(tc.yaml))
			if err != nil {
				t.Fatalf("Parse(%q) failed: %v", tc.yaml, err)
			}
			if diff := cmp.Diff(tc.want, got); diff != "" {
				t.Errorf("Parse(%q) diff (-want +got):\n%s", tc.yaml, diff)
			}
		})
	}
}

func TestParseRejectsUnknownSetting(t *testing.T) {
	yaml := "listen:\n  prot: 9090\n"
	_, err := Parse([]byte(yaml))
	if err == nil {
		t.Fatalf("Parse(%q) succeeded, want an error naming the unknown setting", yaml)
	}
	// The message is what the operator sees at startup, so it must name the
	// misspelled setting.
	if !strings.Contains(err.Error(), "prot") {
		t.Errorf("Parse(%q) error = %q, want it to name %q", yaml, err, "prot")
	}
}

func TestParseValidatesListenAddress(t *testing.T) {
	tests := []struct {
		name    string
		address string
		wantErr error
	}{
		{name: "ipv4_loopback", address: "127.0.0.1"},
		{name: "ipv4_loopback_range", address: "127.5.5.5"},
		{name: "ipv6_loopback", address: "::1"},
		{name: "localhost", address: "localhost"},
		{name: "all_ipv4_interfaces", address: "0.0.0.0", wantErr: ErrNotLoopback},
		{name: "all_ipv6_interfaces", address: "::", wantErr: ErrNotLoopback},
		{name: "lan_address", address: "192.168.1.5", wantErr: ErrNotLoopback},
		{name: "host_name", address: "example.com", wantErr: ErrNotLoopback},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			yaml := "listen:\n  address: \"" + tc.address + "\"\n"
			_, err := Parse([]byte(yaml))
			if !errors.Is(err, tc.wantErr) {
				t.Errorf("Parse(%q) error = %v, want %v", yaml, err, tc.wantErr)
			}
		})
	}
}

func TestParseValidatesPort(t *testing.T) {
	tests := []struct {
		name    string
		port    string
		wantErr bool
	}{
		{name: "lowest", port: "1"},
		{name: "highest", port: "65535"},
		{name: "negative", port: "-1", wantErr: true},
		{name: "too_large", port: "65536", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			yaml := "listen:\n  port: " + tc.port + "\n"
			_, err := Parse([]byte(yaml))
			if (err != nil) != tc.wantErr {
				t.Errorf("Parse(%q) error = %v, want error: %t", yaml, err, tc.wantErr)
			}
		})
	}
}

func TestLoadReadsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kvleva.yaml")
	if err := os.WriteFile(path, []byte("cluster:\n  context: kind-kvleva\n"), 0o600); err != nil {
		t.Fatalf("writing config file: %v", err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatalf("Load(%q) failed: %v", path, err)
	}
	if got.Cluster.Context != "kind-kvleva" {
		t.Errorf("Load(%q).Cluster.Context = %q, want %q", path, got.Cluster.Context, "kind-kvleva")
	}
}

func TestLoadReportsMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.yaml")
	_, err := Load(path)
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Load(%q) error = %v, want fs.ErrNotExist", path, err)
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("Load(%q) error = %q, want it to name the file", path, err)
	}
}

func TestListenAddr(t *testing.T) {
	tests := []struct {
		name   string
		listen Listen
		want   string
	}{
		{name: "ipv4", listen: Listen{Address: "127.0.0.1", Port: 8080}, want: "127.0.0.1:8080"},
		{name: "ipv6", listen: Listen{Address: "::1", Port: 9090}, want: "[::1]:9090"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.listen.Addr(); got != tc.want {
				t.Errorf("%+v.Addr() = %q, want %q", tc.listen, got, tc.want)
			}
		})
	}
}
