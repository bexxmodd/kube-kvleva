package graph

import "sort"

// LogSource names one container whose log can be read.
type LogSource struct {
	Namespace string
	Pod       string
	Container string
}

// LogTargets says which containers hold the logs of a resource.
type LogTargets struct {
	// Sources lists the containers, pod by pod.
	Sources []LogSource
	// Pods is the number of pods Sources covers.
	Pods int
	// TotalPods is the number of pods the resource has. It exceeds Pods
	// when the limit on pods cut the list short.
	TotalPods int
}

// LogTargets returns the containers whose logs stand for the resource with
// the given uid: the containers of a Pod, or those of the Pods nested in the
// resource at any depth, for at most maxPods Pods in the order Pods are
// listed. A resource that runs nothing has no sources. LogTargets reports
// false when there is no such resource.
func (s *Store) LogTargets(uid string, maxPods int) (LogTargets, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	o, ok := s.objects[uid]
	if !ok {
		return LogTargets{}, false
	}
	pods := s.podsWithin(o, 0)
	sort.Slice(pods, func(i, j int) bool { return before(pods[i], pods[j]) })

	targets := LogTargets{TotalPods: len(pods)}
	for _, pod := range pods[:min(len(pods), maxPods)] {
		targets.Pods++
		for _, c := range pod.containers {
			targets.Sources = append(targets.Sources, LogSource{Namespace: pod.namespace, Pod: pod.name, Container: c.Name})
		}
	}
	return targets, true
}

// ContainerLogTarget returns the one container named container of the Pod
// with the given uid as a log target. It reports false when there is no
// such container.
func (s *Store) ContainerLogTarget(uid, container string) (LogTargets, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	o, ok := s.objects[uid]
	if !ok || o.kindID != podKindID {
		return LogTargets{}, false
	}
	for _, c := range o.containers {
		if c.Name == container {
			source := LogSource{Namespace: o.namespace, Pod: o.name, Container: c.Name}
			return LogTargets{Sources: []LogSource{source}, Pods: 1, TotalPods: 1}, true
		}
	}
	return LogTargets{}, false
}

// podsWithin returns o if it is a Pod, and otherwise the Pods displayed
// inside o at any depth.
func (s *Store) podsWithin(o *object, depth int) []*object {
	if o.kindID == podKindID {
		return []*object{o}
	}
	if depth > maxDepth {
		return nil
	}
	var pods []*object
	for _, child := range s.childrenOf(o) {
		pods = append(pods, s.podsWithin(child, depth+1)...)
	}
	return pods
}
