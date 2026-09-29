# Webview Monitor

Session monitoring for partner-bank webviews (VP, TP, PV): measures how a webview session starts up and what goes wrong along the way.

## Language

**First load**:
The time from the user opening the webview until the first pixels paint, i.e. the end of the white screen.
_Avoid_: time to home, load time

**Bundle start**:
The moment the app's JS bundle starts running and the monitor begins its session clock.
_Avoid_: navigation start, page start

**Navigation start**:
The moment the webview begins navigating to the page, before any HTML or JS has downloaded.
_Avoid_: bundle start

**Home ready**:
The moment the host app's boot steps have all settled; measured from bundle start, not navigation start.
_Avoid_: first load, home shown
