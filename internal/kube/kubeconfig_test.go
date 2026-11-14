package kube

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/bexxmodd/kube-kvleva/internal/config"
)

const twoClusterKubeconfig = `
apiVersion: v1
kind: Config
current-context: kind-other
clusters:
- name: kind-kvleva
  cluster: {server: "https://127.0.0.1:6443"}
- name: kind-other
  cluster: {server: "https://127.0.0.1:7443"}
users:
- name: kind-kvleva
  user: {token: kvleva-token}
- name: kind-other
  user: {token: other-token}
contexts:
- name: kind-kvleva
  context: {cluster: kind-kvleva, user: kind-kvleva}
- name: kind-other
  context: {cluster: kind-other, user: kind-other}
`

func writeKubeconfig(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "kubeconfig")
	if err := os.WriteFile(path, []byte(twoClusterKubeconfig), 0o600); err != nil {
		t.Fatalf("writing kubeconfig: %v", err)
	}
	return path
}

func TestRESTConfigSelectsCluster(t *testing.T) {
	path := writeKubeconfig(t)
	tests := []struct {
		name        string
		cluster     config.Cluster
		wantContext string
		wantServer  string
	}{
		{
			name:        "named_context",
			cluster:     config.Cluster{Kubeconfig: path, Context: "kind-kvleva"},
			wantContext: "kind-kvleva",
			wantServer:  "https://127.0.0.1:6443",
		},
		{
			name:        "current_context_by_default",
			cluster:     config.Cluster{Kubeconfig: path},
			wantContext: "kind-other",
			wantServer:  "https://127.0.0.1:7443",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			restConfig, contextName, err := RESTConfig(tc.cluster)
			if err != nil {
				t.Fatalf("RESTConfig(%+v) failed: %v", tc.cluster, err)
			}
			if contextName != tc.wantContext || restConfig.Host != tc.wantServer {
				t.Errorf("RESTConfig(%+v) = context %q, server %q; want context %q, server %q", tc.cluster, contextName, restConfig.Host, tc.wantContext, tc.wantServer)
			}
		})
	}
}

func TestRESTConfigUsesDefaultKubeconfigLocation(t *testing.T) {
	t.Setenv("KUBECONFIG", writeKubeconfig(t))

	_, contextName, err := RESTConfig(config.Cluster{})
	if err != nil {
		t.Fatalf("RESTConfig(default kubeconfig) failed: %v", err)
	}
	if contextName != "kind-other" {
		t.Errorf("RESTConfig(default kubeconfig) context = %q, want %q", contextName, "kind-other")
	}
}

func TestRESTConfigRejectsUnknownContext(t *testing.T) {
	cluster := config.Cluster{Kubeconfig: writeKubeconfig(t), Context: "no-such-context"}
	if _, _, err := RESTConfig(cluster); err == nil {
		t.Errorf("RESTConfig(%+v) succeeded, want an error", cluster)
	}
}

func TestRESTConfigBlocksModifyingRequests(t *testing.T) {
	cluster := config.Cluster{Kubeconfig: writeKubeconfig(t), Context: "kind-kvleva"}
	restConfig, _, err := RESTConfig(cluster)
	if err != nil {
		t.Fatalf("RESTConfig(%+v) failed: %v", cluster, err)
	}
	if restConfig.WrapTransport == nil {
		t.Fatalf("RESTConfig(%+v) does not guard the transport", cluster)
	}
	wire := &countingTransport{}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, "https://127.0.0.1:6443/api/v1/namespaces/default", nil)
	if err != nil {
		t.Fatalf("building request: %v", err)
	}

	resp, err := restConfig.WrapTransport(wire).RoundTrip(req)
	if resp != nil {
		resp.Body.Close()
	}

	if !errors.Is(err, ErrReadOnly) || wire.requests != 0 {
		t.Errorf("DELETE through RESTConfig transport: error = %v, requests on the wire = %d; want ErrReadOnly and 0", err, wire.requests)
	}
}
