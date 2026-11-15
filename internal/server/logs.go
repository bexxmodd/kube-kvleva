package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/bexxmodd/kube-kvleva/internal/graph"
	"github.com/bexxmodd/kube-kvleva/internal/podlogs"
)

// maxLogPods is how many Pods of one resource a log stream follows.
const maxLogPods = 10

// LogOpener reads container logs from the cluster.
type LogOpener interface {
	// Logs opens the log of one container: the lines req asks for and then
	// what the container writes, until ctx is done or the stream is closed.
	Logs(ctx context.Context, req podlogs.Request) (io.ReadCloser, error)
}

// logsInfo tells the web interface whether it can offer the logs of a
// resource, and of how many of its Pods.
type logsInfo struct {
	Available bool `json:"available"`
	Pods      int  `json:"pods"`
	TotalPods int  `json:"totalPods"`
}

// logsInfo describes targets for a detail answer.
func (a *api) logsInfo(targets graph.LogTargets) logsInfo {
	if a.opts.Logs == nil || len(targets.Sources) == 0 {
		return logsInfo{}
	}
	return logsInfo{Available: true, Pods: targets.Pods, TotalPods: targets.TotalPods}
}

// resourceLogs streams the logs of a Pod, or of the Pods nested in a
// resource.
func (a *api) resourceLogs(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	a.streamLogs(w, r, "this resource no longer exists", func() (graph.LogTargets, bool) {
		return a.opts.Store.LogTargets(uid, maxLogPods)
	})
}

// containerLogs streams the log of one container of a Pod.
func (a *api) containerLogs(w http.ResponseWriter, r *http.Request) {
	uid, name := r.PathValue("uid"), r.PathValue("name")
	a.streamLogs(w, r, "this container no longer exists", func() (graph.LogTargets, bool) {
		return a.opts.Store.ContainerLogTarget(uid, name)
	})
}

// streamLogs sends what the containers named by targets write, as
// server-sent events, until the browser leaves or the targets are gone.
// targets is asked again while the stream runs, so the stream keeps up with
// Pods that come and go.
func (a *api) streamLogs(w http.ResponseWriter, r *http.Request, gone string, targets func() (graph.LogTargets, bool)) {
	if a.opts.Logs == nil {
		writeError(w, http.StatusNotFound, "logs are switched off in the configuration")
		return
	}
	first, ok := targets()
	if !ok {
		writeError(w, http.StatusNotFound, gone)
		return
	}
	if len(first.Sources) == 0 {
		writeError(w, http.StatusNotFound, "this resource has no logs: no pods run for it")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	// The browser learns right away that the stream is open, before any
	// container has written a line.
	flusher.Flush()

	// Batches and heartbeats are written from two goroutines.
	var writing sync.Mutex
	ctx, stop := context.WithCancel(r.Context())
	var heartbeats sync.WaitGroup
	// Nothing may write once this handler has returned.
	defer heartbeats.Wait()
	defer stop()
	heartbeats.Go(func() {
		ticker := time.NewTicker(a.opts.Heartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				writing.Lock()
				_, err := fmt.Fprint(w, ": heartbeat\n\n")
				flusher.Flush()
				writing.Unlock()
				if err != nil {
					stop()
					return
				}
			}
		}
	})

	// The error only says that the browser is gone, which ends the stream
	// anyway.
	_ = podlogs.Follow(ctx, podlogs.Options{
		Sources: func() ([]podlogs.Source, bool) {
			current, ok := targets()
			if !ok {
				return nil, false
			}
			sources := make([]podlogs.Source, 0, len(current.Sources))
			for _, s := range current.Sources {
				sources = append(sources, podlogs.Source{Namespace: s.Namespace, Pod: s.Pod, Container: s.Container})
			}
			return sources, true
		},
		Open:          a.opts.Logs.Logs,
		FlushInterval: a.opts.LogFlushInterval,
		RetryInterval: a.opts.LogRetryInterval,
	}, func(batch podlogs.Batch) error {
		data, err := json.Marshal(batch)
		if err != nil {
			return err
		}
		writing.Lock()
		defer writing.Unlock()
		if _, err := fmt.Fprintf(w, "event: logs\ndata: %s\n\n", data); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	})
}
