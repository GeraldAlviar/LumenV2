# Workflow references and limits

Reviewed for the 2.2.0 redesign, 7 September 2026. These are design references, not claims that a Safari camera is equivalent to these instruments or pipelines. No Spyder, Calibrite, ArgyllCMS or OpenVPCal source is incorporated by this revision.

## OpenVPCal (Netflix)

https://github.com/Netflix/OpenVPCal

The camera/display workflow includes automatic regions of interest, manual fallback and fresh validation captures. Lumen adopts that practical idea: locate the actual region or let the user select it, rather than requiring exact guide overlap. Its lightweight coloured-corner detector and projective sample mapping are not OpenVPCal's colour pipeline. OpenVPCal's professional camera/RAW/colour-management context does not establish accuracy for browser-processed iPhone frames.

## ArgyllCMS

https://www.argyllcms.com/doc/Scenarios.html

The documented verification workflow can use a different set of test points from the profiling data. Lumen reserves four tone levels from the fitting set, then offers a fresh before/after capture with a saved baseline. This remains a relative camera check, not ICC conformance, traceable colorimetry or a calibrated Delta E measurement.

## Spyder / Datacolor

https://spyder-support.datacolor.com/hc/en-us/articles/14107825883420-Setup
https://spyder-support.datacolor.com/hc/en-us/articles/14108296618652-Calibration-RGB-Controls-SpyderPro-only

Monitor-control selection and an adjustment stage informed Lumen's optional preparation panel. The user can identify existing controls, view a tone-step pattern and continue when close enough. Lumen deliberately does not copy numeric luminance or RGB-gain instructions that would require a calibrated instrument.

## Web camera API constraints

https://www.w3.org/TR/image-capture/
https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/getCapabilities

Control availability is queried and settings checked. Unsupported manual exposure or white balance is reported rather than silently presented as locked. Geometry correction does not correct unknown colour response, lens shading, local tone mapping, display viewing angle or ambient-light effects.

## Practical distinction

Alignment assistance should not prevent a diagnostic run. Data-quality warnings can be accepted, but acceptance is not evidence of accuracy. This is why a diagnostic override keeps the report and raw exports while withholding correction profiles.
