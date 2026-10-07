---
name: browser-screenshot
description: Use Browser Screenshot when the user wants a PNG capture of a public HTTP(S) web page at a desktop, tablet, mobile, or custom viewport.
---

# Browser Screenshot workflow

Browser Screenshot opens a public HTTP(S) URL in an isolated Chromium browser and returns a PNG image plus capture metadata.

Use `screenshot_create` only when a screenshot or visual capture is actually useful to the user's request.

## Capture

Pass the exact public URL supplied by the user. Choose the requested viewport preset or custom dimensions.

If the user does not specify a viewport, default to desktop.

Set full-page capture only when the user asks for the entire page or when capturing beyond the visible viewport is clearly necessary.

Do not automatically create desktop, tablet, and mobile variants. Capture exactly the requested view unless the user asks for multiple variants.

## Safety and scope

The service is for screenshot capture only. It does not log in, click controls, submit forms, modify websites, or automate workflows beyond navigation required to render the requested public page.

Do not use it for localhost, private-network targets, or other resources that are not public HTTP(S) pages.

Return the screenshot and the metadata reported by the tool. When the host renders the Browser Screenshot viewer, let the user use its **View large** action for fullscreen inspection and **Download PNG** to save the capture locally. Do not invent page dimensions, timing, or capture settings.
