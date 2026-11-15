Feature: Live logs
  As a cluster operator
  I want to read what a workload is printing right now, next to its details
  So that I can see why it misbehaves without leaving the cluster picture

  Rule: Resources that run containers offer their logs

  Scenario Outline: Where the "View Live Logs" button is offered
    Given the details of <resource> are displayed
    Then the "View Live Logs" button is <offered or not>

    Examples:
      | resource                        | offered or not |
      | a container                     | offered        |
      | a pod                           | offered        |
      | a deployment that has pods      | offered        |
      | a job that has pods             | offered        |
      | a deployment that has no pods   | not offered    |
      | a config map                    | not offered    |
      | a gateway                       | not offered    |

  Scenario: The logs of a container are shown as they are written
    Given the details of a running container are displayed
    When "View Live Logs" is used
    Then the most recent lines of the container are shown
    And lines the container writes afterwards appear by themselves

  Scenario: A pod shows the logs of all its containers together
    Given a pod with an "app" and a "sidecar" container
    When the live logs of the pod are viewed
    Then lines of both containers are shown in the order they were written
    And every line says which container wrote it

  Scenario: A workload shows the logs of its pods together
    Given a deployment with 3 pods
    When the live logs of the deployment are viewed
    Then lines of all 3 pods are shown
    And every line says which pod and container wrote it

  Scenario: A large workload is limited to ten pods
    Given a deployment with 23 pods
    When the live logs of the deployment are viewed
    Then the logs of 10 of its pods are shown
    And it is stated that 10 of 23 pods are shown

  Scenario: The logs keep up with restarts and new pods
    Given the live logs of a deployment are viewed
    When one of its containers restarts and a new pod is added
    Then the lines of the restarted container continue without repeating old ones
    And the lines of the new pod appear as well

  Scenario: A container whose log cannot be read is reported, not hidden
    Given a pod with a container that has not started yet
    When the live logs of the pod are viewed
    Then it is stated that the log of that container cannot be read yet, and why
    And its lines appear once it has started

  Scenario: Going back to the details stops the logs
    Given the live logs of a pod are viewed
    When the details are shown again, another resource is chosen, or the panel is closed
    Then no more log lines are requested from the cluster

  Rule: The lines that are shown can be filtered

    The filter narrows what the page already holds. It asks the cluster for
    nothing.

  Background:
    Given the live logs of a pod are viewed
    And the pod wrote "GET /healthz 200", "ERROR disk full", "error: retrying a.b" and "saved axb"

  Scenario: Filtering by a keyword
    When "error" is entered in the filter field
    Then only "ERROR disk full" and "error: retrying a.b" are shown
    And it is stated that 2 of 4 lines are shown

  Scenario: A keyword is taken literally
    When "a.b" is entered in the filter field
    Then only "error: retrying a.b" is shown

  Scenario: Filtering by a regular expression
    When "/^ERROR|200$/" is entered in the filter field
    Then only "GET /healthz 200" and "ERROR disk full" are shown

  Scenario: A regular expression distinguishes upper and lower case unless told otherwise
    When "/error/" is entered in the filter field
    Then only "error: retrying a.b" is shown
    When "/error/i" is entered in the filter field
    Then "ERROR disk full" is shown as well

  Scenario: An invalid regular expression is reported
    When "/(/" is entered in the filter field
    Then it is stated that this is not a valid regular expression
    And all 4 lines stay shown

  Scenario: Lines that arrive later are filtered too
    Given "error" is entered in the filter field
    When the pod writes "200 OK" and "fatal error"
    Then "fatal error" appears
    But "200 OK" does not

  Scenario: Nothing matches
    When "no such text" is entered in the filter field
    Then it is stated that no line matches the filter

  Scenario: Clearing the filter shows every line again
    Given "error" is entered in the filter field
    When the filter field is cleared
    Then all 4 lines are shown

  Scenario: What the app reports about a container is never filtered away
    Given it is stated that the log of the "sidecar" container cannot be read yet
    When "error" is entered in the filter field
    Then that statement stays shown

  Scenario: The filter belongs to one look at the logs
    Given "error" is entered in the filter field
    When the details are shown again and the live logs are viewed once more
    Then the filter field is empty

  Rule: Logs do not weaken the safety of the app

  Scenario: Reading logs changes nothing in the cluster
    When live logs are viewed
    Then the cluster only receives read requests

  Scenario: Log text is shown as text
    Given a container that prints markup and terminal color codes
    When its live logs are viewed
    Then the markup is shown literally and never interpreted
    And the color codes are left out

  Scenario: Logs can be switched off
    Given logs are switched off in the configuration
    When the details of a pod are displayed
    Then the "View Live Logs" button is not offered
    And the app refuses requests for logs
