Feature: Appearance
  As someone who keeps the cluster picture open for long stretches,
  I want text that is comfortable to read and a theme that suits the room I am in,
  so that looking at the cluster is not tiring.

  Rule: The interface comes in a night theme and a day theme

  Scenario: The night theme is the default
    Given the app is opened for the first time
    Then the interface is shown in the night theme
    And a button offers to switch to the day theme

  Scenario: Switching to the day theme
    Given the interface is shown in the night theme
    When the theme button is used
    Then the interface is shown in the day theme
    And the button now offers to switch back to the night theme

  Scenario: Switching the theme does not disturb the cluster picture
    Given a cluster is displayed with some resources opened
    When the theme is switched
    Then the same resources stay opened
    And nothing is requested from the cluster again

  Scenario: The chosen theme is remembered
    Given the day theme was chosen
    When the page is opened again
    Then the interface is shown in the day theme from the first moment
    And the night theme is never flashed before it

  Scenario Outline: Health stays readable in both themes
    Given the interface is shown in the <theme> theme
    Then green, yellow and red resources are clearly distinguishable from their background
    And text is clearly readable on every surface

    Examples:
      | theme |
      | night |
      | day   |

  Rule: Text looks the same on every machine

  Scenario: The typeface ships with the app
    Given a machine that has none of the app's fonts installed
    When the app is opened
    Then text is set in the app's own typeface
    And nothing is fetched from outside the app

  Scenario: Text is comfortably sized
    When the app is opened
    Then ordinary text is slightly larger than the browser's small print
    And no text is too small to read

  Rule: The app has a logo, and the interface wears its colors

  Scenario: The logo stands next to the name of the app
    When the app is opened
    Then the kvleva logo is shown at the top, next to the name of the app
    And the browser tab shows the same logo

  Scenario: The logo shows what the app is for
    When the app is opened
    Then the logo is a K with a magnifying glass where its arms meet
    And the lower arm of the K is the handle of the magnifying glass

  Scenario: The name of the app stands out
    When the app is opened
    Then the name of the app is the largest text on the page
    And the logo next to it is at least as tall as the name

  Scenario: The project introduces itself with its logo
    When the description of the project is opened
    Then the logo is the first thing it shows

  Scenario: The logo is offered on its own
    Given someone wants to use only the logo
    When they open the logo folder of the project
    Then they find the logo as a picture that scales to any size
    And they find the same logo in a range of fixed sizes

  Scenario: The logo ships with the app
    Given a machine that can reach nothing but the app
    When the app is opened
    Then the logo is shown
    And nothing is fetched from outside the app

  Scenario Outline: The interface wears the colors of the logo
    Given the interface is shown in the <theme> theme
    Then whatever is highlighted is drawn in a blue of the logo
    And every color of the logo is a color of the interface

    Examples:
      | theme |
      | night |
      | day   |

  Scenario: The logo is never mistaken for a health
    When the app is opened
    Then no color of the logo is a green, a yellow or a red
