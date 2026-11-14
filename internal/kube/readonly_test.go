package kube

import (
	"errors"
	"net/http"
	"testing"
)

// countingTransport stands in for the connection to the cluster and counts
// the requests that reach it.
type countingTransport struct {
	requests int
}

func (c *countingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	c.requests++
	return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody, Request: req}, nil
}

func TestReadOnly(t *testing.T) {
	tests := []struct {
		name         string
		method       string
		url          string
		header       http.Header
		wantErr      error
		wantRequests int
	}{
		{name: "get", method: http.MethodGet, url: "https://cluster/api/v1/namespaces/default/pods/web", wantRequests: 1},
		{name: "list", method: http.MethodGet, url: "https://cluster/api/v1/pods", wantRequests: 1},
		{name: "watch", method: http.MethodGet, url: "https://cluster/api/v1/pods?watch=true", wantRequests: 1},
		{name: "head", method: http.MethodHead, url: "https://cluster/version", wantRequests: 1},
		{name: "create", method: http.MethodPost, url: "https://cluster/api/v1/namespaces/default/pods", wantErr: ErrReadOnly},
		{name: "update", method: http.MethodPut, url: "https://cluster/api/v1/namespaces/default/pods/web", wantErr: ErrReadOnly},
		{name: "patch", method: http.MethodPatch, url: "https://cluster/api/v1/namespaces/default/pods/web", wantErr: ErrReadOnly},
		{name: "delete", method: http.MethodDelete, url: "https://cluster/api/v1/namespaces/default/pods/web", wantErr: ErrReadOnly},
		{name: "unknown_method", method: "PROPFIND", url: "https://cluster/api/v1/pods", wantErr: ErrReadOnly},
		{
			name:    "interactive_session_over_get",
			method:  http.MethodGet,
			url:     "https://cluster/api/v1/namespaces/default/pods/web/exec?command=sh",
			header:  http.Header{"Connection": {"Upgrade"}, "Upgrade": {"websocket"}},
			wantErr: ErrReadOnly,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cluster := &countingTransport{}
			req, err := http.NewRequestWithContext(t.Context(), tc.method, tc.url, nil)
			if err != nil {
				t.Fatalf("building request: %v", err)
			}
			for key, values := range tc.header {
				req.Header[key] = values
			}

			resp, err := ReadOnly(cluster).RoundTrip(req)
			if resp != nil {
				resp.Body.Close()
			}

			if !errors.Is(err, tc.wantErr) {
				t.Errorf("ReadOnly(cluster).RoundTrip(%s %s) error = %v, want %v", tc.method, tc.url, err, tc.wantErr)
			}
			if cluster.requests != tc.wantRequests {
				t.Errorf("ReadOnly(cluster).RoundTrip(%s %s) let %d requests reach the cluster, want %d", tc.method, tc.url, cluster.requests, tc.wantRequests)
			}
		})
	}
}
