package kube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/bexxmodd/kube-kvleva/internal/podlogs"
)

// maxRefusalBytes bounds how much of an error answer is read.
const maxRefusalBytes = 16 * 1024

// Logs opens the log of one container: the lines req asks for, each
// preceded by its timestamp, and then whatever the container writes until
// ctx is done or the returned stream is closed. Reading a log is a read
// request, so it passes the read-only transport like every other request.
func (c *Client) Logs(ctx context.Context, req podlogs.Request) (io.ReadCloser, error) {
	// Escaping keeps a name from ever addressing anything but one log.
	target := c.server.JoinPath("api", "v1",
		"namespaces", url.PathEscape(req.Namespace), "pods", url.PathEscape(req.Pod), "log")
	query := url.Values{
		"container":  {req.Container},
		"follow":     {"true"},
		"timestamps": {"true"},
	}
	if req.Since.IsZero() {
		query.Set("tailLines", strconv.FormatInt(req.TailLines, 10))
	} else {
		// The cluster reads whole seconds. Rounding down repeats a few
		// lines rather than losing any.
		query.Set("sinceTime", req.Since.UTC().Truncate(time.Second).Format(time.RFC3339))
	}
	target.RawQuery = query.Encode()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("asking for the log: %w", err)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("asking for the log: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		defer response.Body.Close()
		return nil, refusal(response)
	}
	return response.Body, nil
}

// refusal turns an error answer of the cluster into an error. The cluster
// explains itself in a Status object; its message is what a person needs.
func refusal(response *http.Response) error {
	body, err := io.ReadAll(io.LimitReader(response.Body, maxRefusalBytes))
	if err == nil {
		var status struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(body, &status) == nil && status.Message != "" {
			return errors.New(status.Message)
		}
	}
	return fmt.Errorf("the cluster answered %s", response.Status)
}
