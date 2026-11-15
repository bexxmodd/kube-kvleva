// Package podlogs follows the logs of a changing set of containers and
// merges them into one stream of batches.
//
// It knows nothing about Kubernetes clients or HTTP: the caller says which
// containers to follow and how to open the log of one. That keeps the
// merging, the cleaning of log text, and the reconnecting testable on their
// own.
package podlogs

import (
	"bufio"
	"context"
	"io"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// maxLineBytes is the longest log line passed on; longer ones are cut.
	maxLineBytes = 16 * 1024
	// timestampRoom is added to the read buffer for the timestamp that
	// precedes each line.
	timestampRoom = 64
	// truncationMark ends a line that was cut.
	truncationMark = "…"

	// A stream starts with the most recent lines of every container. The
	// budget is shared between the containers within these bounds.
	tailBudget = 500
	maxTail    = 100
	minTail    = 10

	// maxBatchLines is how many lines may wait before they are emitted
	// without waiting for the flush interval.
	maxBatchLines = 1000

	defaultFlushInterval    = 200 * time.Millisecond
	defaultRetryInterval    = 3 * time.Second
	defaultMaxRetryInterval = 30 * time.Second
)

// Source names one container.
type Source struct {
	Namespace string
	Pod       string
	Container string
}

// Request asks for the log of one container, from some point on.
type Request struct {
	Source
	// TailLines is how many of the most recent lines to start with. It is
	// zero when Since is set.
	TailLines int64
	// Since, when not zero, asks for the lines written at or after it.
	Since time.Time
}

// Line is one line a container wrote.
type Line struct {
	Pod       string `json:"pod"`
	Container string `json:"container"`
	// Time is the timestamp recorded for the line, in RFC 3339 form with
	// nanoseconds, or "" when there is none.
	Time string `json:"time"`
	// Text is the line as plain text: terminal escape sequences and
	// control characters are removed and very long lines are cut.
	Text string `json:"text"`

	// at is Time parsed, or when the line arrived if it has no Time.
	at time.Time
}

// Notice says why the log of a container cannot be read.
type Notice struct {
	Pod       string `json:"pod"`
	Container string `json:"container"`
	Message   string `json:"message"`
}

// Batch is what was collected since the previous batch. Its lines are in
// time order.
type Batch struct {
	Lines   []Line   `json:"lines"`
	Notices []Notice `json:"notices"`
}

// Options configures Follow.
type Options struct {
	// Sources returns the containers to follow at the moment. It is asked
	// again every RetryInterval. Reporting false means that what is being
	// followed no longer exists, which ends Follow.
	Sources func() ([]Source, bool)
	// Open opens the log of one container as a stream of lines, each
	// optionally preceded by an RFC 3339 timestamp and a space. The stream
	// must end when ctx is done or when it is closed.
	Open func(ctx context.Context, req Request) (io.ReadCloser, error)
	// FlushInterval is how long lines are collected before they are
	// emitted as one batch. Zero means 200 ms.
	FlushInterval time.Duration
	// RetryInterval is how often the set of containers is refreshed and
	// how soon an ended log is opened again. Zero means 3 s.
	RetryInterval time.Duration
	// MaxRetryInterval bounds the pause between attempts on a log that
	// stays silent or cannot be opened; the pause doubles from
	// RetryInterval up to it. Zero means 30 s.
	MaxRetryInterval time.Duration
}

// Follow reads the logs of the containers named by opts.Sources and calls
// emit with what they wrote, batch by batch, until ctx is done or the
// sources are gone; it then returns nil. A log that ends, because its
// container restarted for example, is opened again from where it stopped,
// and a log that cannot be opened is reported once per reason and retried.
// Follow returns the error of emit when a batch cannot be delivered.
func Follow(ctx context.Context, opts Options, emit func(Batch) error) error {
	if opts.FlushInterval <= 0 {
		opts.FlushInterval = defaultFlushInterval
	}
	if opts.RetryInterval <= 0 {
		opts.RetryInterval = defaultRetryInterval
	}
	if opts.MaxRetryInterval <= 0 {
		opts.MaxRetryInterval = defaultMaxRetryInterval
	}
	ctx, cancel := context.WithCancel(ctx)
	f := &follower{
		opts:     opts,
		events:   make(chan event, 256),
		trackers: make(map[Source]*tracker),
	}
	// Whatever ends Follow, no reader outlives it.
	defer f.readers.Wait()
	defer cancel()

	flush := time.NewTicker(opts.FlushInterval)
	defer flush.Stop()
	retry := time.NewTicker(opts.RetryInterval)
	defer retry.Stop()

	if !f.reconcile(ctx) {
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev := <-f.events:
			f.handle(ev)
			if len(f.pending.Lines) < maxBatchLines {
				continue
			}
			if err := f.flush(emit); err != nil {
				return err
			}
		case <-flush.C:
			if err := f.flush(emit); err != nil {
				return err
			}
		case <-retry.C:
			if f.reconcile(ctx) {
				continue
			}
			// Hand over what the readers have delivered so far.
			f.drain()
			return f.flush(emit)
		}
	}
}

// follower is the state of one Follow call. Only the goroutine running
// Follow touches it; readers report to it through events.
type follower struct {
	opts     Options
	events   chan event
	readers  sync.WaitGroup
	trackers map[Source]*tracker
	pending  Batch
}

// tracker is what is known about the log of one container.
type tracker struct {
	// run numbers the attempts to read the log; events of earlier attempts
	// are ignored.
	run     int
	running bool
	// stop ends the running reader.
	stop context.CancelFunc
	// last is the time of the newest line seen.
	last time.Time
	// gotLines says whether the current attempt delivered a line.
	gotLines bool
	// notice is the last reason reported for not being able to read.
	notice string
	// nextTry is when to open the log again, and pause is the wait before
	// the attempt after that.
	nextTry time.Time
	pause   time.Duration
}

// event is what a reader reports: a line, or the end of its attempt.
type event struct {
	source Source
	run    int
	line   *Line
	// err is why the log could not be opened, on the end of an attempt.
	err error
}

// reconcile brings the readers in line with the containers to follow: it
// starts reading logs that are new or due for another attempt and stops
// reading those that are no longer wanted. It reports false when there is
// nothing to follow any more.
func (f *follower) reconcile(ctx context.Context) bool {
	sources, ok := f.opts.Sources()
	if !ok {
		return false
	}
	wanted := make(map[Source]bool, len(sources))
	now := time.Now()
	for _, src := range sources {
		wanted[src] = true
		t, known := f.trackers[src]
		if !known {
			t = &tracker{pause: f.opts.RetryInterval}
			f.trackers[src] = t
		}
		if t.running || now.Before(t.nextTry) {
			continue
		}
		req := Request{Source: src, Since: t.last}
		if t.last.IsZero() {
			req.TailLines = tailLines(len(sources))
		}
		readerCtx, stop := context.WithCancel(ctx)
		t.run++
		t.running, t.gotLines, t.stop = true, false, stop
		f.readers.Add(1)
		go f.read(readerCtx, req, t.run)
	}
	for src, t := range f.trackers {
		if wanted[src] {
			continue
		}
		if t.stop != nil {
			t.stop()
		}
		delete(f.trackers, src)
	}
	return true
}

// tailLines is how many recent lines each of n containers starts with.
func tailLines(n int) int64 {
	return int64(min(max(tailBudget/n, minTail), maxTail))
}

// handle applies what a reader reported.
func (f *follower) handle(ev event) {
	t, ok := f.trackers[ev.source]
	if !ok || ev.run != t.run {
		// From a container that is no longer followed, or from an attempt
		// that was replaced.
		return
	}
	if ev.line != nil {
		if ev.line.at.After(t.last) {
			t.last = ev.line.at
		}
		if ev.line.Time == "" {
			ev.line.at = time.Now()
		}
		t.gotLines, t.notice = true, ""
		f.pending.Lines = append(f.pending.Lines, *ev.line)
		return
	}

	// The attempt ended.
	t.running = false
	t.stop()
	if ev.err != nil {
		if message := ev.err.Error(); message != t.notice {
			t.notice = message
			f.pending.Notices = append(f.pending.Notices, Notice{
				Pod: ev.source.Pod, Container: ev.source.Container, Message: message,
			})
		}
	}
	if t.gotLines {
		// A log that was live is worth looking at again soon.
		t.pause = f.opts.RetryInterval
		t.nextTry = time.Now().Add(t.pause)
		return
	}
	t.nextTry = time.Now().Add(t.pause)
	t.pause = min(2*t.pause, f.opts.MaxRetryInterval)
}

// drain applies the events that are already waiting.
func (f *follower) drain() {
	for {
		select {
		case ev := <-f.events:
			f.handle(ev)
		default:
			return
		}
	}
}

// flush emits what is pending, if anything.
func (f *follower) flush(emit func(Batch) error) error {
	if len(f.pending.Lines) == 0 && len(f.pending.Notices) == 0 {
		return nil
	}
	batch := Batch{Lines: f.pending.Lines, Notices: f.pending.Notices}
	f.pending = Batch{}
	if batch.Lines == nil {
		batch.Lines = []Line{}
	}
	if batch.Notices == nil {
		batch.Notices = []Notice{}
	}
	// Containers deliver independently; within a batch their lines are
	// put back into the order they were written in.
	sort.SliceStable(batch.Lines, func(i, j int) bool { return batch.Lines[i].at.Before(batch.Lines[j].at) })
	return emit(batch)
}

// read makes one attempt at the log of a container: it opens the log,
// reports its lines, and reports when it ended.
func (f *follower) read(ctx context.Context, req Request, run int) {
	defer f.readers.Done()
	stream, err := f.opts.Open(ctx, req)
	if err != nil {
		f.report(ctx, event{source: req.Source, run: run, err: err})
		return
	}
	// A read that is waiting for the next line only returns when the
	// stream is closed.
	stopClosing := context.AfterFunc(ctx, func() { stream.Close() })
	defer stream.Close()
	defer stopClosing()

	reader := bufio.NewReaderSize(stream, maxLineBytes+timestampRoom)
	for {
		raw, tooLong, err := reader.ReadLine()
		if err != nil {
			// Why a stream ended does not matter: it is opened again.
			break
		}
		line := parseLine(req.Source, raw, tooLong)
		ended := tooLong && !discardRestOfLine(reader)
		// The cluster starts at a whole second, so a reopened log repeats
		// lines that were already seen.
		repeated := !req.Since.IsZero() && !line.at.IsZero() && !line.at.After(req.Since)
		if !repeated && !f.report(ctx, event{source: req.Source, run: run, line: &line}) {
			return
		}
		if ended {
			break
		}
	}
	f.report(ctx, event{source: req.Source, run: run})
}

// report hands ev to the follower. It reports false when ctx ended first.
func (f *follower) report(ctx context.Context, ev event) bool {
	select {
	case f.events <- ev:
		return true
	case <-ctx.Done():
		return false
	}
}

// discardRestOfLine skips what is left of a line that did not fit the read
// buffer. It reports false when the stream ended before the line did.
func discardRestOfLine(reader *bufio.Reader) bool {
	for {
		_, more, err := reader.ReadLine()
		if err != nil {
			return false
		}
		if !more {
			return true
		}
	}
}

// parseLine splits the timestamp off a raw log line and cleans its text.
// cut says that the line was longer than raw.
func parseLine(src Source, raw []byte, cut bool) Line {
	line := Line{Pod: src.Pod, Container: src.Container}
	text := string(raw)
	stamp, rest, _ := strings.Cut(text, " ")
	if at, err := time.Parse(time.RFC3339Nano, stamp); err == nil {
		line.Time, line.at, text = stamp, at, rest
	}
	text = clean(text)
	if len(text) > maxLineBytes {
		text, cut = cutAtRune(text, maxLineBytes), true
	}
	if cut {
		text += truncationMark
	}
	line.Text = text
	return line
}

// escapeSequences matches what terminals interpret rather than show: CSI
// sequences such as colors, OSC sequences such as window titles, and the
// two-character escapes.
var escapeSequences = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\^_]`)

// clean reduces log output to plain text: valid UTF-8 without terminal
// escape sequences and without control characters other than the tab.
func clean(text string) string {
	text = strings.ToValidUTF8(text, string(utf8.RuneError))
	text = escapeSequences.ReplaceAllString(text, "")
	return strings.Map(func(r rune) rune {
		if r != '\t' && unicode.IsControl(r) {
			return -1
		}
		return r
	}, text)
}

// cutAtRune shortens text to at most limit bytes without splitting a
// character.
func cutAtRune(text string, limit int) string {
	for limit > 0 && !utf8.RuneStart(text[limit]) {
		limit--
	}
	return text[:limit]
}
