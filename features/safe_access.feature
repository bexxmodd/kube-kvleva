Feature: Safe access
  As a cluster operator
  I want the visualizer to be strictly read-only and strictly local
  So that running it can never change my cluster or expose it to others

  Rule: The app never changes the cluster

  Scenario Outline: Reading the cluster is allowed
    When the app sends a <kind> request to the cluster
    Then the request reaches the cluster

    Examples:
      | kind  |
      | get   |
      | list  |
      | watch |

  Scenario Outline: Anything that could change the cluster is blocked before it is sent
    When the app attempts to <action> a resource in the cluster
    Then the request is refused without reaching the cluster

    Examples:
      | action  |
      | create  |
      | update  |
      | patch   |
      | delete  |

  Scenario: Interactive sessions into the cluster are blocked
    When the app attempts to open an interactive connection into the cluster
    Then the request is refused without reaching the cluster

  Scenario: The web interface offers no way to change anything
    When a browser sends a modifying request to the app
    Then the request is rejected

  Rule: Secret values never leave the backend

  Scenario: Secret values are redacted
    Given a secret holding a password
    When the secret's details are displayed
    Then the name of the password entry is shown
    But its value is not shown

  Rule: The app only serves the local machine

  Scenario: The app refuses to listen on a public address
    Given a configuration that asks the app to listen on every network interface
    When the app starts
    Then startup fails with an explanation that only local addresses are allowed

  Scenario: A local browser is served
    When a browser on the same machine opens the app at its local address
    Then the app responds

  Scenario: A request from another machine is refused
    When a request arrives from another machine
    Then the request is refused

  Scenario: A request addressed to a non-local host name is refused
    When a request arrives that addresses the app by a non-local host name
    Then the request is refused

  Scenario: A request initiated by another website is refused
    When a page from another website makes the browser call the app
    Then the request is refused
