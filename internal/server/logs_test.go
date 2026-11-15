package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"

	"github.com/bexxmodd/kube-kvleva/internal/graph"
	"github.com/bexxmodd/kube-kvleva/internal/podlogs"
)

const (
	deploymentManifest = `
apiVersion: apps/v1
kind: Deployment
metadata: {namespace: default, name: shop, uid: deployment-shop, resourceVersion: "1"}
`
	replicaSetManifest = `
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  namespace: default
  name: shop-5d
  uid: replicaset-shop-5d
  resourceVersion: "1"
  ownerReferences:
  - {apiVersion: apps/v1, kind: Deployment, name: shop, uid: deployment-shop, controller: true}
`
	shopPodA = `
apiVersion: v1
kind: Pod
metadata:
  namespace: default
  name: shop-5d-a
  uid: pod-shop-a
  resourceVersion: "1"
  ownerReferences:
  - {apiVersion: apps/v1, kind: ReplicaSet, name: shop-5d, uid: replicaset-shop-5d, controller: true}
spec:
  containers:
  - {name: app, image: "shop:1"}
`
	shopPodB = `
apiVersion: v1
kind: Pod
metadata:
  namespace: default
  name: shop-5d-b
  uid: pod-shop-b
  resourceVersion: "1"
  ownerReferences:
  - {apiVersion: apps/v1, kind: ReplicaSet, name: shop-5d, uid: replicaset-shop-5d, controller: true}
spec:
  containers:
  - {name: app, image: "shop:1"}
`
)

var (
	webSetup = podlogs.Source{Namespace: "default", Pod: "web", Container: "setup"}
	webApp   = podlogs.Source{Namespace: "default", Pod: "web", Container: "app"}
	shopA    = podlogs.Source{Namespace: "default", Pod: "shop-5d-a", Container: "app"}
	shopB    = podlogs.Source{Namespace: "default", Pod: "shop-5d-b", Container: "app"}
)

// fakeLogs stands in for the container logs of a cluster.
type fakeLogs struct {
	mu      sync.Mutex
	opened  []podlogs.Source
	writers map[podlogs.Source]*io.PipeWriter
	closed  map[podlogs.Source]bool
	refusal error
}

func newFakeLogs() *fakeLogs {
	return &fakeLogs{writers: make(map[podlogs.Source]*io.PipeWriter), closed: make(map[podlogs.Source]bool)}
}

// logStream is the reading end of a fake log; it records being closed.
type logStream struct {
	*io.PipeReader
	closed func()
}

func (s logStream) Close() error {
	s.closed()
	return s.PipeReader.Close()
}

func (f *fakeLogs) Logs(_ context.Context, req podlogs.Request) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refusal != nil {
		return nil, f.refusal
	}
	r, w := io.Pipe()
	f.opened = append(f.opened, req.Source)
	f.writers[req.Source] = w
	return logStream{PipeReader: r, closed: func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.closed[req.Source] = true
	}}, nil
}

// write appends a line to the log of src once the server has opened it.
func (f *fakeLogs) write(t *testing.T, src podlogs.Source, line string) {
	t.Helper()
	var w *io.PipeWriter
	if !eventually(func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		w = f.writers[src]
		return w != nil
	}) {
		t.Fatalf("the server never opened the log of %+v", src)
	}
	if _, err := io.WriteString(w, line+"\n"); err != nil {
		t.Fatalf("writing to the log of %+v: %v", src, err)
	}
}

func (f *fakeLogs) sources() []podlogs.Source {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]podlogs.Source(nil), f.opened...)
}

func (f *fakeLogs) isClosed(src podlogs.Source) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed[src]
}

// eventually polls cond for a few seconds.
func eventually(cond func() bool) bool {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return cond()
}

// logOptions are server options that make log streams react quickly.
func logOptions(store *graph.Store, logs LogOpener) Options {
	return Options{
		Store:            store,
		Assets:           testAssets,
		Logs:             logs,
		LogFlushInterval: 2 * time.Millisecond,
		LogRetryInterval: 10 * time.Millisecond,
	}
}

// openLogs requests target from a server over real HTTP and returns the
// answer; the request ends with the test.
func openLogs(t *testing.T, opts Options, target string) *http.Response {
	t.Helper()
	srv := httptest.NewServer(New(opts))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+target, nil)
	if err != nil {
		t.Fatalf("building request for %s: %v", target, err)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("GET %s failed: %v", target, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// readLogs reads the next "logs" event of a stream.
func readLogs(t *testing.T, target string, stream *bufio.Reader) podlogs.Batch {
	t.Helper()
	event, err := readEvent(stream)
	if err != nil {
		t.Fatalf("GET %s: reading the next event failed: %v", target, err)
	}
	if event.name != "logs" {
		t.Fatalf("GET %s sent a %q event, want a logs event", target, event.name)
	}
	var batch podlogs.Batch
	if err := json.Unmarshal([]byte(event.data), &batch); err != nil {
		t.Fatalf("GET %s sent unreadable JSON %q: %v", target, event.data, err)
	}
	return batch
}

var ignoreLineInternals = cmpopts.IgnoreUnexported(podlogs.Line{})

func TestDetailSaysWhetherLogsCanBeViewed(t *testing.T) {
	type logsInfo struct {
		Available bool `json:"available"`
		Pods      int  `json:"pods"`
		TotalPods int  `json:"totalPods"`
	}
	store := newStore(t, podManifest, configMapManifest, deploymentManifest, replicaSetManifest, shopPodA, shopPodB)
	tests := []struct {
		name   string
		logs   LogOpener
		target string
		want   logsInfo
	}{
		{name: "pod", logs: newFakeLogs(), target: "/api/resources/pod-web", want: logsInfo{Available: true, Pods: 1, TotalPods: 1}},
		{name: "container", logs: newFakeLogs(), target: "/api/resources/pod-web/containers/app", want: logsInfo{Available: true, Pods: 1, TotalPods: 1}},
		{name: "workload_with_pods", logs: newFakeLogs(), target: "/api/resources/deployment-shop", want: logsInfo{Available: true, Pods: 2, TotalPods: 2}},
		{name: "resource_that_runs_nothing", logs: newFakeLogs(), target: "/api/resources/configmap-settings", want: logsInfo{}},
		{name: "pod_while_logs_are_switched_off", logs: nil, target: "/api/resources/pod-web", want: logsInfo{}},
		{name: "container_while_logs_are_switched_off", logs: nil, target: "/api/resources/pod-web/containers/app", want: logsInfo{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			handler := New(Options{Store: store, Assets: testAssets, Logs: tc.logs})
			rec := serve(handler, localRequest(http.MethodGet, tc.target))
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s = %d %s, want 200", tc.target, rec.Code, rec.Body)
			}
			var got struct {
				Logs *logsInfo `json:"logs"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("GET %s returned unreadable JSON: %v\n%s", tc.target, err, rec.Body)
			}
			if got.Logs == nil {
				t.Fatalf("GET %s has no logs field:\n%s", tc.target, rec.Body)
			}
			if diff := cmp.Diff(tc.want, *got.Logs); diff != "" {
				t.Errorf("GET %s logs diff (-want +got):\n%s", tc.target, diff)
			}
		})
	}
}

func TestLogsStreamsWhatThePodsOfAResourceWrite(t *testing.T) {
	logs := newFakeLogs()
	store := newStore(t, deploymentManifest, replicaSetManifest, shopPodA, shopPodB)
	const target = "/api/resources/deployment-shop/logs"
	resp := openLogs(t, logOptions(store, logs), target)
	if got := resp.Header.Get("Content-Type"); resp.StatusCode != http.StatusOK || got != "text/event-stream" {
		t.Fatalf("GET %s = %d with Content-Type %q, want 200 text/event-stream", target, resp.StatusCode, got)
	}
	stream := bufio.NewReader(resp.Body)

	logs.write(t, shopA, "2026-11-15T18:00:01Z order received")
	want := podlogs.Batch{
		Lines:   []podlogs.Line{{Pod: "shop-5d-a", Container: "app", Time: "2026-11-15T18:00:01Z", Text: "order received"}},
		Notices: []podlogs.Notice{},
	}
	if diff := cmp.Diff(want, readLogs(t, target, stream), ignoreLineInternals); diff != "" {
		t.Errorf("GET %s first event diff (-want +got):\n%s", target, diff)
	}

	// Later lines follow by themselves, from any of the pods.
	logs.write(t, shopB, "2026-11-15T18:00:05Z order shipped")
	want = podlogs.Batch{
		Lines:   []podlogs.Line{{Pod: "shop-5d-b", Container: "app", Time: "2026-11-15T18:00:05Z", Text: "order shipped"}},
		Notices: []podlogs.Notice{},
	}
	if diff := cmp.Diff(want, readLogs(t, target, stream), ignoreLineInternals); diff != "" {
		t.Errorf("GET %s second event diff (-want +got):\n%s", target, diff)
	}
}

func TestLogsOpensTheContainersThatWereAskedFor(t *testing.T) {
	tests := []struct {
		name   string
		target string
		want   []podlogs.Source
	}{
		{name: "every_container_of_a_pod", target: "/api/resources/pod-web/logs", want: []podlogs.Source{webApp, webSetup}},
		{name: "one_container", target: "/api/resources/pod-web/containers/app/logs", want: []podlogs.Source{webApp}},
		{name: "one_init_container", target: "/api/resources/pod-web/containers/setup/logs", want: []podlogs.Source{webSetup}},
		{name: "the_pods_of_a_workload", target: "/api/resources/replicaset-shop-5d/logs", want: []podlogs.Source{shopA, shopB}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			logs := newFakeLogs()
			store := newStore(t, podManifest, deploymentManifest, replicaSetManifest, shopPodA, shopPodB)
			resp := openLogs(t, logOptions(store, logs), tc.target)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("GET %s = %d, want 200", tc.target, resp.StatusCode)
			}

			if !eventually(func() bool { return len(logs.sources()) >= len(tc.want) }) {
				t.Fatalf("GET %s opened the logs of %+v, want %+v", tc.target, logs.sources(), tc.want)
			}
			byName := cmpopts.SortSlices(func(a, b podlogs.Source) bool { return a.Pod+"/"+a.Container < b.Pod+"/"+b.Container })
			if diff := cmp.Diff(tc.want, logs.sources(), byName); diff != "" {
				t.Errorf("GET %s opened logs diff (-want +got):\n%s", tc.target, diff)
			}
		})
	}
}

func TestLogsReportsALogThatCannotBeRead(t *testing.T) {
	logs := newFakeLogs()
	logs.refusal = errors.New(`container "app" in pod "web" is waiting to start: ContainerCreating`)
	const target = "/api/resources/pod-web/containers/app/logs"
	resp := openLogs(t, logOptions(newStore(t, podManifest), logs), target)

	want := podlogs.Batch{
		Lines:   []podlogs.Line{},
		Notices: []podlogs.Notice{{Pod: "web", Container: "app", Message: logs.refusal.Error()}},
	}
	if diff := cmp.Diff(want, readLogs(t, target, bufio.NewReader(resp.Body)), ignoreLineInternals); diff != "" {
		t.Errorf("GET %s first event diff (-want +got):\n%s", target, diff)
	}
}

func TestLogsRefusesWhatHasNoLogs(t *testing.T) {
	store := newStore(t, podManifest, configMapManifest, deploymentManifest)
	tests := []struct {
		name      string
		logs      LogOpener
		target    string
		wantError string
	}{
		{name: "unknown_resource", logs: newFakeLogs(), target: "/api/resources/no-such-uid/logs", wantError: "no longer exists"},
		{name: "unknown_container", logs: newFakeLogs(), target: "/api/resources/pod-web/containers/nope/logs", wantError: "no longer exists"},
		{name: "resource_that_runs_nothing", logs: newFakeLogs(), target: "/api/resources/configmap-settings/logs", wantError: "no pods"},
		{name: "workload_without_pods", logs: newFakeLogs(), target: "/api/resources/deployment-shop/logs", wantError: "no pods"},
		{name: "logs_switched_off", logs: nil, target: "/api/resources/pod-web/logs", wantError: "switched off"},
		{name: "container_logs_switched_off", logs: nil, target: "/api/resources/pod-web/containers/app/logs", wantError: "switched off"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			handler := New(Options{Store: store, Assets: testAssets, Logs: tc.logs})
			rec := serve(handler, localRequest(http.MethodGet, tc.target))
			var body struct {
				Error string `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); rec.Code != http.StatusNotFound || err != nil {
				t.Fatalf("GET %s = %d %s, want 404 with a JSON error message", tc.target, rec.Code, rec.Body)
			}
			if !strings.Contains(body.Error, tc.wantError) {
				t.Errorf("GET %s error = %q, want it to say %q", tc.target, body.Error, tc.wantError)
			}
		})
	}
}

func TestLogsCannotBeAskedForWithAModifyingRequest(t *testing.T) {
	logs := newFakeLogs()
	handler := New(Options{Store: newStore(t, podManifest), Assets: testAssets, Logs: logs})
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		for _, target := range []string{"/api/resources/pod-web/logs", "/api/resources/pod-web/containers/app/logs"} {
			rec := serve(handler, localRequest(method, target))
			if rec.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s %s = %d, want %d", method, target, rec.Code, http.StatusMethodNotAllowed)
			}
		}
	}
	if got := logs.sources(); len(got) != 0 {
		t.Errorf("modifying requests opened the logs of %+v, want none", got)
	}
}

func TestLogsEndsWhenTheResourceIsGone(t *testing.T) {
	logs := newFakeLogs()
	store := newStore(t, podManifest)
	const target = "/api/resources/pod-web/containers/app/logs"
	resp := openLogs(t, logOptions(store, logs), target)
	stream := bufio.NewReader(resp.Body)
	logs.write(t, webApp, "2026-11-15T18:00:01Z last words")
	if got := readLogs(t, target, stream); len(got.Lines) != 1 {
		t.Fatalf("GET %s first event = %+v, want the one line written", target, got)
	}

	store.Delete("pod-web")

	if rest, err := io.ReadAll(stream); err != nil {
		t.Errorf("GET %s ended with %v after the pod was deleted, want a clean end; read %q", target, err, rest)
	}
	if !eventually(func() bool { return logs.isClosed(webApp) }) {
		t.Errorf("GET %s left the log of the deleted pod open", target)
	}
}

func TestLogsStopsReadingWhenTheBrowserLeaves(t *testing.T) {
	logs := newFakeLogs()
	const target = "/api/resources/pod-web/logs"
	resp := openLogs(t, logOptions(newStore(t, podManifest), logs), target)
	stream := bufio.NewReader(resp.Body)
	logs.write(t, webApp, "2026-11-15T18:00:01Z hello")
	if got := readLogs(t, target, stream); len(got.Lines) != 1 {
		t.Fatalf("GET %s first event = %+v, want the one line written", target, got)
	}

	resp.Body.Close()

	for _, src := range []podlogs.Source{webApp, webSetup} {
		if !eventually(func() bool { return logs.isClosed(src) }) {
			t.Errorf("GET %s kept reading the log of %+v after the browser left", target, src)
		}
	}
}

func TestLogsSendsHeartbeats(t *testing.T) {
	opts := logOptions(newStore(t, podManifest), newFakeLogs())
	opts.Heartbeat = 10 * time.Millisecond
	const target = "/api/resources/pod-web/logs"
	stream := bufio.NewReader(openLogs(t, opts, target).Body)
	for {
		line, err := stream.ReadString('\n')
		if err != nil {
			t.Fatalf("GET %s ended before a heartbeat arrived: %v", target, err)
		}
		if strings.HasPrefix(line, ":") {
			return
		}
	}
}
