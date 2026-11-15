package podlogs

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
)

var (
	webApp     = Source{Namespace: "default", Pod: "web-1", Container: "app"}
	webSidecar = Source{Namespace: "default", Pod: "web-1", Container: "sidecar"}
	web2App    = Source{Namespace: "default", Pod: "web-2", Container: "app"}

	ignoreInternals = cmpopts.IgnoreUnexported(Line{})
)

// fakeCluster stands in for the log endpoint of a cluster. Tests write to
// the logs of containers, end their streams, and make the cluster refuse.
type fakeCluster struct {
	mu       sync.Mutex
	requests []Request
	streams  map[Source]*io.PipeWriter
	closed   map[Source]int
	refusals map[Source]error
}

func newFakeCluster() *fakeCluster {
	return &fakeCluster{
		streams:  make(map[Source]*io.PipeWriter),
		closed:   make(map[Source]int),
		refusals: make(map[Source]error),
	}
}

// stream is the reading end of a log stream; it counts being closed.
type stream struct {
	*io.PipeReader
	close func()
}

func (s stream) Close() error {
	s.close()
	return s.PipeReader.Close()
}

func (c *fakeCluster) open(_ context.Context, req Request) (io.ReadCloser, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests = append(c.requests, req)
	if err := c.refusals[req.Source]; err != nil {
		return nil, err
	}
	r, w := io.Pipe()
	c.streams[req.Source] = w
	var once sync.Once
	return stream{PipeReader: r, close: func() {
		once.Do(func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			c.closed[req.Source]++
		})
	}}, nil
}

// write appends lines to the open log stream of src.
func (c *fakeCluster) write(src Source, lines ...string) {
	c.mu.Lock()
	w := c.streams[src]
	c.mu.Unlock()
	// A stream the follower already closed takes no more lines, like a
	// connection that is gone.
	_, _ = io.WriteString(w, strings.Join(lines, "\n")+"\n")
}

// end ends the open log stream of src, as when its container stops.
func (c *fakeCluster) end(src Source) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.streams[src].Close()
}

func (c *fakeCluster) refuse(src Source, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refusals[src] = err
}

func (c *fakeCluster) received() []Request {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Request(nil), c.requests...)
}

func (c *fakeCluster) timesClosed(src Source) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed[src]
}

// sources is a set of containers to follow that a test can change.
type sources struct {
	mu   sync.Mutex
	list []Source
	gone bool
}

func (s *sources) set(list ...Source) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.list = list
}

func (s *sources) remove() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gone = true
}

func (s *sources) current() ([]Source, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Source(nil), s.list...), !s.gone
}

// following is a Follow call running in the background.
type following struct {
	mu      sync.Mutex
	batches []Batch
	// result receives what Follow returned.
	result chan error
}

func (f *following) emit(b Batch) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.batches = append(f.batches, b)
	return nil
}

// take returns the batches emitted since the last call.
func (f *following) take() []Batch {
	f.mu.Lock()
	defer f.mu.Unlock()
	batches := f.batches
	f.batches = nil
	return batches
}

// lines returns the texts of every line emitted since the last call.
func (f *following) lines() []string {
	var texts []string
	for _, b := range f.take() {
		for _, l := range b.Lines {
			texts = append(texts, l.Text)
		}
	}
	return texts
}

const (
	flushEvery = 200 * time.Millisecond
	retryEvery = 3 * time.Second
)

// start runs Follow for the given containers until ctx is done.
func start(ctx context.Context, cluster *fakeCluster, current func() ([]Source, bool)) *following {
	f := &following{result: make(chan error, 1)}
	go func() {
		f.result <- Follow(ctx, Options{
			Sources:          current,
			Open:             cluster.open,
			FlushInterval:    flushEvery,
			RetryInterval:    retryEvery,
			MaxRetryInterval: 30 * time.Second,
		}, f.emit)
	}()
	return f
}

func fixed(list ...Source) func() ([]Source, bool) {
	return func() ([]Source, bool) { return list, true }
}

func TestFollowEmitsTheLinesOfEveryContainerInTimeOrder(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cluster := newFakeCluster()
		f := start(t.Context(), cluster, fixed(webApp, webSidecar))
		synctest.Wait()

		// The two streams deliver out of order.
		cluster.write(webSidecar, "2026-11-15T18:00:02.5Z proxy ready")
		cluster.write(webApp, "2026-11-15T18:00:01Z starting", "2026-11-15T18:00:03.000000001Z listening on :80")
		time.Sleep(flushEvery)
		synctest.Wait()

		want := []Batch{{
			Lines: []Line{
				{Pod: "web-1", Container: "app", Time: "2026-11-15T18:00:01Z", Text: "starting"},
				{Pod: "web-1", Container: "sidecar", Time: "2026-11-15T18:00:02.5Z", Text: "proxy ready"},
				{Pod: "web-1", Container: "app", Time: "2026-11-15T18:00:03.000000001Z", Text: "listening on :80"},
			},
			Notices: []Notice{},
		}}
		if diff := cmp.Diff(want, f.take(), ignoreInternals); diff != "" {
			t.Errorf("Follow emitted batches diff (-want +got):\n%s", diff)
		}

		// Nothing new, nothing emitted.
		time.Sleep(10 * flushEvery)
		synctest.Wait()
		if got := f.take(); len(got) != 0 {
			t.Errorf("Follow emitted %+v while the containers wrote nothing, want no batch", got)
		}
	})
}

func TestFollowStartsWithRecentLinesWithinABudget(t *testing.T) {
	tests := []struct {
		name       string
		containers int
		wantTail   int64
	}{
		{name: "one_container", containers: 1, wantTail: 100},
		{name: "five_containers", containers: 5, wantTail: 100},
		{name: "ten_containers_share_the_budget", containers: 10, wantTail: 50},
		{name: "many_containers_keep_a_minimum", containers: 80, wantTail: 10},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var list []Source
				for i := range tc.containers {
					list = append(list, Source{Namespace: "default", Pod: "web", Container: string(rune('a' + i))})
				}
				cluster := newFakeCluster()
				start(t.Context(), cluster, fixed(list...))
				synctest.Wait()

				requests := cluster.received()
				if len(requests) != tc.containers {
					t.Fatalf("Follow opened %d log streams, want one per container: %d", len(requests), tc.containers)
				}
				for _, req := range requests {
					if req.TailLines != tc.wantTail || !req.Since.IsZero() {
						t.Errorf("Follow asked for %+v, want the last %d lines and no start time", req, tc.wantTail)
					}
				}
			})
		})
	}
}

func TestFollowShowsLogTextAsPlainText(t *testing.T) {
	long := strings.Repeat("x", 20000)
	tests := []struct {
		name     string
		written  string
		wantTime string
		wantText string
	}{
		{
			name:     "timestamp_is_split_off",
			written:  "2026-11-15T18:00:00.123456789Z GET /healthz 200",
			wantTime: "2026-11-15T18:00:00.123456789Z",
			wantText: "GET /healthz 200",
		},
		{
			name:     "empty_message",
			written:  "2026-11-15T18:00:00Z ",
			wantTime: "2026-11-15T18:00:00Z",
			wantText: "",
		},
		{
			name:     "line_without_timestamp",
			written:  "plain line",
			wantText: "plain line",
		},
		{
			name:     "markup_is_kept_as_text",
			written:  "2026-11-15T18:00:00Z <img src=x onerror=alert(1)>",
			wantTime: "2026-11-15T18:00:00Z",
			wantText: "<img src=x onerror=alert(1)>",
		},
		{
			name:     "terminal_colors_are_removed",
			written:  "2026-11-15T18:00:00Z \x1b[1;31mERROR\x1b[0m disk \x1b[38;5;208mfull\x1b[m",
			wantTime: "2026-11-15T18:00:00Z",
			wantText: "ERROR disk full",
		},
		{
			name:     "terminal_title_sequences_are_removed",
			written:  "2026-11-15T18:00:00Z \x1b]0;my title\x07ready",
			wantTime: "2026-11-15T18:00:00Z",
			wantText: "ready",
		},
		{
			name:     "control_characters_are_removed_but_tabs_stay",
			written:  "2026-11-15T18:00:00Z a\tb\x00c\x08d\r",
			wantTime: "2026-11-15T18:00:00Z",
			wantText: "a\tbcd",
		},
		{
			name:     "invalid_utf8_is_replaced",
			written:  "2026-11-15T18:00:00Z caf\xff\xfe!",
			wantTime: "2026-11-15T18:00:00Z",
			wantText: "caf\uFFFD!",
		},
		{
			name:     "very_long_line_is_cut",
			written:  "2026-11-15T18:00:00Z " + long,
			wantTime: "2026-11-15T18:00:00Z",
			wantText: long[:16384] + "…",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				cluster := newFakeCluster()
				f := start(t.Context(), cluster, fixed(webApp))
				synctest.Wait()

				cluster.write(webApp, tc.written, "2026-11-15T18:00:09Z next line")
				time.Sleep(flushEvery)
				synctest.Wait()

				want := []Batch{{
					Lines: []Line{
						{Pod: "web-1", Container: "app", Time: tc.wantTime, Text: tc.wantText},
						{Pod: "web-1", Container: "app", Time: "2026-11-15T18:00:09Z", Text: "next line"},
					},
					Notices: []Notice{},
				}}
				if diff := cmp.Diff(want, f.take(), ignoreInternals); diff != "" {
					t.Errorf("Follow emitted batches for %q diff (-want +got):\n%s", tc.written, diff)
				}
			})
		})
	}
}

func TestFollowContinuesAfterARestartWithoutRepeatingLines(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cluster := newFakeCluster()
		f := start(t.Context(), cluster, fixed(webApp))
		synctest.Wait()

		cluster.write(webApp, "2026-11-15T18:00:01Z first run", "2026-11-15T18:00:02.25Z crashing")
		// The container stops, which ends its stream.
		cluster.end(webApp)
		time.Sleep(flushEvery)
		synctest.Wait()
		if diff := cmp.Diff([]string{"first run", "crashing"}, f.lines()); diff != "" {
			t.Fatalf("Follow emitted lines diff (-want +got):\n%s", diff)
		}

		// A few seconds later the log is opened again, from where it stopped.
		time.Sleep(retryEvery)
		synctest.Wait()
		requests := cluster.received()
		if len(requests) != 2 {
			t.Fatalf("Follow opened %d log streams, want 2: one per run of the container", len(requests))
		}
		lastSeen := time.Date(2026, 11, 15, 18, 0, 2, 250000000, time.UTC)
		if again := requests[1]; !again.Since.Equal(lastSeen) || again.TailLines != 0 {
			t.Errorf("Follow reopened the log with %+v, want it to start at %v, the last line seen", again, lastSeen)
		}

		// The cluster repeats what falls into the same second; only what is
		// new is emitted.
		cluster.write(webApp,
			"2026-11-15T18:00:02.25Z crashing",
			"2026-11-15T18:00:02.75Z second run",
			"2026-11-15T18:00:04Z listening")
		time.Sleep(flushEvery)
		synctest.Wait()
		if diff := cmp.Diff([]string{"second run", "listening"}, f.lines()); diff != "" {
			t.Errorf("Follow emitted lines after the restart diff (-want +got):\n%s", diff)
		}
	})
}

func TestFollowReportsWhyALogCannotBeReadAndKeepsTrying(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cluster := newFakeCluster()
		waiting := errors.New(`container "sidecar" in pod "web-1" is waiting to start: ContainerCreating`)
		cluster.refuse(webSidecar, waiting)
		f := start(t.Context(), cluster, fixed(webApp, webSidecar))
		synctest.Wait()

		cluster.write(webApp, "2026-11-15T18:00:01Z up")
		time.Sleep(flushEvery)
		synctest.Wait()
		want := []Batch{{
			Lines:   []Line{{Pod: "web-1", Container: "app", Time: "2026-11-15T18:00:01Z", Text: "up"}},
			Notices: []Notice{{Pod: "web-1", Container: "sidecar", Message: waiting.Error()}},
		}}
		if diff := cmp.Diff(want, f.take(), ignoreInternals); diff != "" {
			t.Fatalf("Follow emitted batches diff (-want +got):\n%s", diff)
		}

		// Still refused: tried again, but the same reason is not repeated.
		time.Sleep(retryEvery + flushEvery)
		synctest.Wait()
		if got := f.take(); len(got) != 0 {
			t.Errorf("Follow emitted %+v for an unchanged reason, want nothing", got)
		}

		// A different reason is news.
		forbidden := errors.New(`pods "web-1" is forbidden: cannot get resource "pods/log"`)
		cluster.refuse(webSidecar, forbidden)
		time.Sleep(time.Minute)
		synctest.Wait()
		want = []Batch{{
			Lines:   []Line{},
			Notices: []Notice{{Pod: "web-1", Container: "sidecar", Message: forbidden.Error()}},
		}}
		if diff := cmp.Diff(want, f.take(), ignoreInternals); diff != "" {
			t.Errorf("Follow emitted batches after the reason changed diff (-want +got):\n%s", diff)
		}

		// Once the container has started its lines appear.
		cluster.refuse(webSidecar, nil)
		time.Sleep(time.Minute)
		synctest.Wait()
		cluster.write(webSidecar, "2026-11-15T18:05:00Z proxy ready")
		time.Sleep(flushEvery)
		synctest.Wait()
		if diff := cmp.Diff([]string{"proxy ready"}, f.lines()); diff != "" {
			t.Errorf("Follow emitted lines once the container started diff (-want +got):\n%s", diff)
		}
	})
}

func TestFollowRetriesASilentContainerLessAndLessOften(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cluster := newFakeCluster()
		cluster.refuse(webApp, errors.New("container is not running"))
		start(t.Context(), cluster, fixed(webApp))

		time.Sleep(time.Minute)
		synctest.Wait()

		// At once, then after 3 s, 6 s, 12 s and 24 s: at 0, 3, 9, 21 and 45 s.
		if got := len(cluster.received()); got != 5 {
			t.Errorf("Follow tried to open the log %d times in a minute, want 5 with growing pauses", got)
		}
	})
}

func TestFollowKeepsUpWithContainersThatAppearAndDisappear(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cluster := newFakeCluster()
		current := &sources{}
		current.set(webApp)
		f := start(t.Context(), cluster, current.current)
		synctest.Wait()

		// A new pod is added and the first one goes away.
		current.set(web2App)
		time.Sleep(retryEvery)
		synctest.Wait()

		if got := cluster.timesClosed(webApp); got != 1 {
			t.Errorf("the log stream of the container that is gone was closed %d times, want once", got)
		}
		cluster.write(web2App, "2026-11-15T18:00:01Z hello from the new pod")
		time.Sleep(flushEvery)
		synctest.Wait()
		want := []Batch{{
			Lines:   []Line{{Pod: "web-2", Container: "app", Time: "2026-11-15T18:00:01Z", Text: "hello from the new pod"}},
			Notices: []Notice{},
		}}
		if diff := cmp.Diff(want, f.take(), ignoreInternals); diff != "" {
			t.Errorf("Follow emitted batches diff (-want +got):\n%s", diff)
		}
	})
}

func TestFollowEndsWhenItsSubjectIsGone(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cluster := newFakeCluster()
		current := &sources{}
		current.set(webApp)
		f := start(t.Context(), cluster, current.current)
		synctest.Wait()
		cluster.write(webApp, "2026-11-15T18:00:01Z last words")

		current.remove()
		time.Sleep(retryEvery)
		synctest.Wait()

		select {
		case err := <-f.result:
			if err != nil {
				t.Errorf("Follow returned %v when its subject was gone, want nil", err)
			}
		default:
			t.Fatal("Follow is still running after its subject was gone")
		}
		if diff := cmp.Diff([]string{"last words"}, f.lines()); diff != "" {
			t.Errorf("Follow emitted lines diff (-want +got):\n%s", diff)
		}
		if got := cluster.timesClosed(webApp); got != 1 {
			t.Errorf("the open log stream was closed %d times, want once", got)
		}
	})
}

func TestFollowStopsAndClosesItsStreamsWhenTheContextEnds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cluster := newFakeCluster()
		ctx, cancel := context.WithCancel(t.Context())
		f := start(ctx, cluster, fixed(webApp, webSidecar))
		synctest.Wait()

		cancel()
		synctest.Wait()

		select {
		case err := <-f.result:
			if err != nil {
				t.Errorf("Follow returned %v when its context ended, want nil", err)
			}
		default:
			t.Fatal("Follow is still running after its context ended")
		}
		for _, src := range []Source{webApp, webSidecar} {
			if got := cluster.timesClosed(src); got != 1 {
				t.Errorf("the log stream of %v was closed %d times, want once", src, got)
			}
		}
	})
}

func TestFollowStopsWhenTheBatchesCannotBeDelivered(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cluster := newFakeCluster()
		broken := errors.New("the browser is gone")
		result := make(chan error, 1)
		go func() {
			result <- Follow(t.Context(), Options{
				Sources:       fixed(webApp),
				Open:          cluster.open,
				FlushInterval: flushEvery,
				RetryInterval: retryEvery,
			}, func(Batch) error { return broken })
		}()
		synctest.Wait()

		cluster.write(webApp, "2026-11-15T18:00:01Z nobody is listening")
		time.Sleep(flushEvery)
		synctest.Wait()

		select {
		case err := <-result:
			if !errors.Is(err, broken) {
				t.Errorf("Follow returned %v, want the delivery error %v", err, broken)
			}
		default:
			t.Fatal("Follow is still running after a batch could not be delivered")
		}
	})
}
