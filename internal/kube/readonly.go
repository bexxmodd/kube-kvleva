// Package kube connects kvleva to a Kubernetes cluster and keeps a
// graph.Store in step with it.
//
// Everything in this package only ever reads from the cluster. That is not
// left to discipline: the connection is built on a transport that refuses to
// send anything but read requests (see ReadOnly).
package kube

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// ErrReadOnly is returned for every request that could change the cluster.
// Such requests are refused before anything is sent.
var ErrReadOnly = errors.New("kvleva is read-only: refusing to send a request that could change the cluster")

// ReadOnly returns a transport that passes read requests (get, list, watch)
// on to next and refuses everything else with ErrReadOnly. Connection
// upgrades are refused too, because interactive sessions such as exec and
// port-forward can be opened with a GET request.
func ReadOnly(next http.RoundTripper) http.RoundTripper {
	return &readOnlyTransport{next: next}
}

type readOnlyTransport struct {
	next http.RoundTripper
}

func (t *readOnlyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		return nil, fmt.Errorf("%w: %s %s", ErrReadOnly, req.Method, req.URL.Path)
	}
	if isUpgrade(req.Header) {
		return nil, fmt.Errorf("%w: connection upgrade for %s", ErrReadOnly, req.URL.Path)
	}
	return t.next.RoundTrip(req)
}

func isUpgrade(header http.Header) bool {
	if header.Get("Upgrade") != "" {
		return true
	}
	for _, value := range header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
				return true
			}
		}
	}
	return false
}
