Feature: Resource health colors
  As a cluster operator
  I want every resource widget outlined in green, yellow, or red
  So that I can see at a glance what is healthy, what is still working, and what failed

  Rule: Green means configured and reconciled, yellow means in progress or stuck, red means failed

  Scenario Outline: Pod health follows what its containers are doing
    Given a pod that is <situation>
    When its health is evaluated
    Then the pod is <color>

    Examples:
      | situation                                   | color  |
      | running with every container ready          | green  |
      | completed successfully                      | green  |
      | waiting to be scheduled                     | yellow |
      | still creating its containers               | yellow |
      | running with a container that is not ready  | yellow |
      | being deleted                               | yellow |
      | crash-looping                               | red    |
      | unable to pull its image                    | red    |
      | failed                                      | red    |

  Scenario Outline: Workload health follows its rollout
    Given a <workload> that <situation>
    When its health is evaluated
    Then the workload is <color>

    Examples:
      | workload    | situation                                  | color  |
      | deployment  | has all replicas updated and available     | green  |
      | deployment  | is still rolling out replicas              | yellow |
      | deployment  | has not been observed by its controller    | yellow |
      | deployment  | exceeded its progress deadline             | red    |
      | statefulset | has all replicas ready                     | green  |
      | statefulset | is waiting for replicas to become ready    | yellow |
      | daemonset   | has a pod ready on every scheduled node    | green  |
      | daemonset   | is missing ready pods                      | yellow |
      | job         | completed                                  | green  |
      | job         | is still running                           | yellow |
      | job         | failed                                     | red    |

  Scenario Outline: Infrastructure resources report their own state
    Given a <resource> that is <situation>
    When its health is evaluated
    Then the resource is <color>

    Examples:
      | resource              | situation                         | color  |
      | node                  | ready                             | green  |
      | node                  | under memory pressure             | yellow |
      | node                  | not ready                         | red    |
      | persistent volume claim | bound                           | green  |
      | persistent volume claim | waiting for a volume            | yellow |
      | persistent volume claim | lost                            | red    |
      | namespace             | active                            | green  |
      | namespace             | terminating                       | yellow |
      | load balancer service | waiting for an address            | yellow |

  Scenario: A resource without any status is considered configured
    Given a config map
    When its health is evaluated
    Then the resource is green

  Scenario Outline: Custom resources are judged by their reported conditions
    Given a custom resource whose controller reports <report>
    When its health is evaluated
    Then the resource is <color>

    Examples:
      | report                                         | color  |
      | that it is ready                               | green  |
      | that it is still reconciling                   | yellow |
      | nothing yet for the latest change              | yellow |
      | an unknown outcome                             | yellow |
      | that it is stalled                             | yellow |
      | that it is not ready because of an error       | red    |
      | that it is not ready because it is in progress | yellow |

  Scenario Outline: Gateway API resources are judged by acceptance and programming
    Given a <resource> that <situation>
    When its health is evaluated
    Then the resource is <color>

    Examples:
      | resource   | situation                                   | color  |
      | gateway    | is accepted and programmed                  | green  |
      | gateway    | is waiting for a controller                 | yellow |
      | gateway    | has a listener with unresolved references   | red    |
      | http route | is accepted by every parent gateway         | green  |
      | http route | has not been picked up by any gateway yet   | yellow |
      | http route | was rejected by a parent gateway            | red    |

  Scenario Outline: Containers are colored individually inside their pod
    Given a container that is <situation>
    When its health is evaluated
    Then the container is <color>

    Examples:
      | situation                      | color  |
      | running and ready              | green  |
      | finished with exit code zero   | green  |
      | running but not ready          | yellow |
      | being created                  | yellow |
      | crash-looping                  | red    |
      | finished with a non-zero code  | red    |
