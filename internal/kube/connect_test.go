package kube

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/google/go-cmp/cmp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/bexxmodd/kube-kvleva/internal/config"
)

// apiServer is a minimal stand-in for a Kubernetes API server that records
// the method of every request it receives.
type apiServer struct {
	*httptest.Server

	mu      sync.Mutex
	methods []string
}

func newAPIServer(t *testing.T) *apiServer {
	t.Helper()
	api := &apiServer{}
	api.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		api.mu.Lock()
		api.methods = append(api.methods, r.Method)
		api.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/version":
			fmt.Fprint(w, `{"major": "1", "minor": "35", "gitVersion": "v1.35.0"}`)
		case "/api/v1/namespaces/default/configmaps":
			fmt.Fprint(w, `{"apiVersion": "v1", "kind": "ConfigMapList", "metadata": {"resourceVersion": "1"}, "items": []}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(api.Close)
	return api
}

func (a *apiServer) receivedMethods() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.methods...)
}

// kubeconfigFor writes a kubeconfig whose only context, "test-cluster",
// points at server.
func kubeconfigFor(t *testing.T, server string) config.Cluster {
	t.Helper()
	content := fmt.Sprintf(`
apiVersion: v1
kind: Config
current-context: test-cluster
clusters:
- name: test-cluster
  cluster: {server: %q}
users:
- name: tester
  user: {token: test-token}
contexts:
- name: test-cluster
  context: {cluster: test-cluster, user: tester}
`, server)
	path := filepath.Join(t.TempDir(), "kubeconfig")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("writing kubeconfig: %v", err)
	}
	return config.Cluster{Kubeconfig: path}
}

func TestConnectDescribesTheCluster(t *testing.T) {
	api := newAPIServer(t)
	cluster := kubeconfigFor(t, api.URL)

	client, err := Connect(t.Context(), cluster)
	if err != nil {
		t.Fatalf("Connect(%+v) failed: %v", cluster, err)
	}
	want := Info{Name: "test-cluster", Server: api.URL, Version: "v1.35.0"}
	if diff := cmp.Diff(want, client.Info); diff != "" {
		t.Errorf("Connect(%+v).Info diff (-want +got):\n%s", cluster, diff)
	}
}

func TestConnectFailsWhenTheClusterIsUnreachable(t *testing.T) {
	api := newAPIServer(t)
	cluster := kubeconfigFor(t, api.URL)
	api.Close()

	if _, err := Connect(t.Context(), cluster); err == nil {
		t.Errorf("Connect(%+v) to a stopped cluster succeeded, want an error", cluster)
	}
}

func TestConnectedClientCannotModifyTheCluster(t *testing.T) {
	api := newAPIServer(t)
	client, err := Connect(t.Context(), kubeconfigFor(t, api.URL))
	if err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	configMaps := client.dynamic.Resource(configMapsGVR).Namespace("default")
	configMap := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata":   map[string]any{"namespace": "default", "name": "settings"},
	}}

	if _, err := configMaps.List(t.Context(), metav1.ListOptions{}); err != nil {
		t.Errorf("listing through the connected client failed: %v", err)
	}
	if _, err := configMaps.Create(t.Context(), configMap, metav1.CreateOptions{}); !errors.Is(err, ErrReadOnly) {
		t.Errorf("creating through the connected client: error = %v, want ErrReadOnly", err)
	}
	if _, err := configMaps.Update(t.Context(), configMap, metav1.UpdateOptions{}); !errors.Is(err, ErrReadOnly) {
		t.Errorf("updating through the connected client: error = %v, want ErrReadOnly", err)
	}
	if err := configMaps.Delete(t.Context(), "settings", metav1.DeleteOptions{}); !errors.Is(err, ErrReadOnly) {
		t.Errorf("deleting through the connected client: error = %v, want ErrReadOnly", err)
	}

	for _, method := range api.receivedMethods() {
		if method != http.MethodGet {
			t.Errorf("the cluster received a %s request, want only GET requests", method)
		}
	}
}
