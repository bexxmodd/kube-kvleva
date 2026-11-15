// Package server serves the kvleva web interface and its JSON API.
//
// The server is read-only and local-only by construction: every request
// passes through guards that reject anything that is not a GET from the
// local machine addressed to a local host name, before any handler runs.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/bexxmodd/kube-kvleva/internal/graph"
	"github.com/bexxmodd/kube-kvleva/internal/kube"
)

const (
	defaultStreamInterval = time.Second
	defaultHeartbeat      = 15 * time.Second
	// eventsTimeout bounds how long a details request waits for the
	// cluster's events.
	eventsTimeout = 10 * time.Second

	contentSecurityPolicy = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)

// EventLister looks up the Kubernetes Events about a resource.
type EventLister interface {
	Events(ctx context.Context, namespace, uid string) ([]kube.Event, error)
}

// Options configures the handler returned by New.
type Options struct {
	// Cluster describes the connected cluster.
	Cluster kube.Info
	// Store is the model of the cluster to serve.
	Store *graph.Store
	// Events looks up events for the details view. It may be nil, in which
	// case no events are shown.
	Events EventLister
	// Assets holds the static files of the web interface; index.html is
	// served at "/".
	Assets fs.FS
	// StreamInterval is the minimum time between two change events on the
	// stream. Zero means one second.
	StreamInterval time.Duration
	// Heartbeat is how often an idle stream is kept alive. Zero means 15
	// seconds.
	Heartbeat time.Duration
}

// New returns the HTTP handler of the web interface and its API.
func New(opts Options) http.Handler {
	if opts.StreamInterval <= 0 {
		opts.StreamInterval = defaultStreamInterval
	}
	if opts.Heartbeat <= 0 {
		opts.Heartbeat = defaultHeartbeat
	}
	a := &api{opts: opts}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", a.healthz)
	mux.HandleFunc("/api/overview", a.overview)
	mux.HandleFunc("/api/resources", a.resources)
	mux.HandleFunc("/api/resources/{uid}", a.resource)
	mux.HandleFunc("/api/resources/{uid}/containers/{name}", a.container)
	mux.HandleFunc("/api/stream", a.stream)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "no such API endpoint")
	})
	mux.Handle("/", http.FileServerFS(opts.Assets))
	return localOnly(readOnly(secured(mux)))
}

// CheckLoopback returns an error unless addr, the address a listener is
// bound to, can only be reached from the local machine.
func CheckLoopback(addr net.Addr) error {
	tcp, ok := addr.(*net.TCPAddr)
	if !ok || !tcp.IP.IsLoopback() {
		return fmt.Errorf("listening on %v, which is not a local (loopback) address", addr)
	}
	return nil
}

// localOnly rejects requests that do not come from this machine or that a
// browser is sending on behalf of another site.
//
// Three independent checks apply. The peer address must be loopback. The
// Host header must name this machine as local, which defeats DNS rebinding:
// a hostile page that points its own domain at 127.0.0.1 still sends its own
// host name. And a request that a browser marks as coming from a different
// origin is refused, so no other site, and no other local application, can
// read the cluster through the user's browser.
func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case !isLoopbackPeer(r.RemoteAddr):
			writeError(w, http.StatusForbidden, "kvleva only serves the local machine")
		case !isLocalHost(r.Host):
			writeError(w, http.StatusForbidden, "kvleva must be addressed as localhost")
		case !isSameOrigin(r):
			writeError(w, http.StatusForbidden, "cross-origin requests are not allowed")
		default:
			next.ServeHTTP(w, r)
		}
	})
}

func isLoopbackPeer(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// isLocalHost reports whether a Host header value names the local machine:
// "localhost" or a loopback IP address, with or without a port.
func isLocalHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// isSameOrigin reports whether the request was made by the web interface
// itself or typed into the browser, as opposed to being triggered by
// another origin.
func isSameOrigin(r *http.Request) bool {
	// Browsers classify every request they send. "none" is a direct
	// navigation; anything else than "same-origin" involves another site.
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host != "" && strings.EqualFold(u.Host, r.Host)
}

// readOnly rejects every request that is not a plain read.
func readOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeError(w, http.StatusMethodNotAllowed, "kvleva is read-only")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// secured adds the response headers that keep the page from loading or
// being embedded by anything but itself.
func secured(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Set("Content-Security-Policy", contentSecurityPolicy)
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("X-Frame-Options", "DENY")
		header.Set("Referrer-Policy", "no-referrer")
		// The assets are embedded in the binary and change with it, and API
		// answers describe a moving cluster: nothing may be served stale.
		header.Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

type api struct {
	opts Options
}

func (a *api) healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintln(w, "ok")
}

func (a *api) overview(w http.ResponseWriter, r *http.Request) {
	showSystem, err := systemSwitch(r.URL.Query())
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Cluster kube.Info `json:"cluster"`
		graph.Overview
	}{a.opts.Cluster, a.opts.Store.Overview(graph.OverviewOptions{HideSystem: !showSystem})})
}

func (a *api) resources(w http.ResponseWriter, r *http.Request) {
	query, err := parseQuery(r.URL.Query())
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, a.opts.Store.List(query))
}

func (a *api) resource(w http.ResponseWriter, r *http.Request) {
	detail, ok := a.opts.Store.Detail(r.PathValue("uid"))
	if !ok {
		writeError(w, http.StatusNotFound, "this resource no longer exists")
		return
	}
	events, eventsError := a.events(r.Context(), detail.Summary, "")
	writeJSON(w, http.StatusOK, struct {
		graph.Detail
		Events      []kube.Event `json:"events"`
		EventsError string       `json:"eventsError"`
	}{detail, events, eventsError})
}

func (a *api) container(w http.ResponseWriter, r *http.Request) {
	detail, ok := a.opts.Store.Container(r.PathValue("uid"), r.PathValue("name"))
	if !ok {
		writeError(w, http.StatusNotFound, "this container no longer exists")
		return
	}
	// Events about a container are recorded against its Pod and name the
	// container in their field path.
	section := "containers"
	if detail.Container.Init {
		section = "initContainers"
	}
	fieldPath := fmt.Sprintf("spec.%s{%s}", section, detail.Container.Name)
	events, eventsError := a.events(r.Context(), detail.Pod, fieldPath)
	writeJSON(w, http.StatusOK, struct {
		graph.ContainerDetail
		Events      []kube.Event `json:"events"`
		EventsError string       `json:"eventsError"`
	}{detail, events, eventsError})
}

// events returns the events about a resource, limited to those with the
// given field path unless it is empty. A failure is returned as text to
// show next to the rest of the details, which do not depend on events.
func (a *api) events(ctx context.Context, subject graph.Summary, fieldPath string) ([]kube.Event, string) {
	events := make([]kube.Event, 0)
	if a.opts.Events == nil {
		return events, ""
	}
	ctx, cancel := context.WithTimeout(ctx, eventsTimeout)
	defer cancel()
	all, err := a.opts.Events.Events(ctx, subject.Namespace, subject.UID)
	if err != nil {
		return events, err.Error()
	}
	for _, event := range all {
		if fieldPath == "" || event.FieldPath == fieldPath {
			events = append(events, event)
		}
	}
	return events, ""
}

// stream tells the browser, as server-sent events, that resources changed.
// It carries only identifiers; the browser refetches what it shows.
func (a *api) stream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}
	// Subscribe before reporting the current revision so that no change
	// can fall between the two.
	sub := a.opts.Store.Subscribe()
	defer sub.Close()

	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	send := func(change graph.Change) bool {
		data, err := json.Marshal(change)
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(w, "event: change\ndata: %s\n\n", data); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !send(graph.Change{Revision: a.opts.Store.Revision(), Changed: []string{}, Deleted: []string{}}) {
		return
	}

	heartbeat := time.NewTicker(a.opts.Heartbeat)
	defer heartbeat.Stop()
	ctx := r.Context()
	lastSent := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-sub.Ready():
			// Let a burst of changes accumulate into one event.
			if wait := a.opts.StreamInterval - time.Since(lastSent); wait > 0 {
				select {
				case <-ctx.Done():
					return
				case <-time.After(wait):
				}
			}
			if !send(sub.Take()) {
				return
			}
			lastSent = time.Now()
		}
	}
}

// parseQuery translates the query parameters of /api/resources.
func parseQuery(values url.Values) (graph.Query, error) {
	var query graph.Query
	scopes := 0
	for _, scope := range []struct {
		param string
		scope graph.Scope
		flag  bool
	}{
		{param: "namespace", scope: graph.ScopeNamespace},
		{param: "parent", scope: graph.ScopeChildren},
		{param: "node", scope: graph.ScopePodsOnNode},
		{param: "cluster", scope: graph.ScopeCluster, flag: true},
		{param: "nodes", scope: graph.ScopeNodes, flag: true},
	} {
		value := values.Get(scope.param)
		if value == "" {
			continue
		}
		if scope.flag {
			enabled, err := strconv.ParseBool(value)
			if err != nil {
				return graph.Query{}, fmt.Errorf("%s must be true or false", scope.param)
			}
			if !enabled {
				continue
			}
		} else {
			query.Target = value
		}
		query.Scope = scope.scope
		scopes++
	}
	if scopes > 1 {
		return graph.Query{}, errors.New("only one of namespace, cluster, nodes, parent, and node may be given")
	}

	query.HideKinds = splitList(values.Get("hideKinds"))
	query.Health = splitList(values.Get("health"))
	for _, status := range query.Health {
		if status != "green" && status != "yellow" && status != "red" {
			return graph.Query{}, fmt.Errorf("health %q must be green, yellow, or red", status)
		}
	}
	query.Text = values.Get("q")

	showSystem, err := systemSwitch(values)
	if err != nil {
		return graph.Query{}, err
	}
	query.HideSystem = !showSystem

	if query.Limit, err = nonNegative(values, "limit"); err != nil {
		return graph.Query{}, err
	}
	if query.Offset, err = nonNegative(values, "offset"); err != nil {
		return graph.Query{}, err
	}
	return query, nil
}

// systemSwitch reads the "system" parameter: whether system resources are
// part of the answer. They are left out unless it is true, which is the
// state the switch in the web interface starts in.
func systemSwitch(values url.Values) (bool, error) {
	raw := values.Get("system")
	if raw == "" {
		return false, nil
	}
	show, err := strconv.ParseBool(raw)
	if err != nil {
		return false, errors.New("system must be true or false")
	}
	return show, nil
}

func splitList(value string) []string {
	var items []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}

func nonNegative(values url.Values, param string) (int, error) {
	raw := values.Get(param)
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s must be a non-negative number", param)
	}
	return n, nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		// The status line is already sent; all that is left is to note it.
		log.Printf("Writing response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
