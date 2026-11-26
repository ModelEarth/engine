# Voices

**"Show the voices"**, **"Can I hear other voices?"**  
Shows the voice buttons below the circle (show_voices). Tap one to hear it and turn it on. Several can be on, and they take turns.

**"Hide the voices"**  
Hides the voice buttons (hide_voices).

**"Use Bella"**, **"Add George"**, **"Just Bella"**, **"Turn off Eve"**  
Turns voices on or off (set_voices). Claude's next words are in the new voice.

## Commands

**"Show commands"**, **"What can I say?"**  
Opens these tabs (show_commands). The ⓘ beside the voice buttons does the same.

**"Hide commands"**  
Closes them (hide_commands).

## Adding Commands to a Page

A page adds its own commands with `registerPageTool({ name, description, inputSchema, execute })` from localsite/js/localsite.js: an MCP tool definition with a function that changes the page. The voice widget sends the page's tools with each question, and Claude runs one by writing an action tag in its reply. Browsers with WebMCP (`document.modelContext`) get the same tools.
