# Music

Say these to Claude, or type them. Claude reads each question and its choices aloud, with a clip of the song playing.

**"Ask me Georgia music trivia"**, **"Quiz me on music"**  
Starts the questions, in random order (trivia_question). The clip plays for a few seconds, then Claude asks the question. The clip keeps playing softly under it.

**"Ask me about Macon"**, **"Just Athens questions"**  
Asks only the questions about that city.

**"Gladys Knight"**, **"The second one"**, **"I think it's 13"**  
Your guess. Claude says whether it's right and adds a fact about the song, and the clip plays again from the start (trivia_answer). Tapping a choice on the card works too.

**"Say the choices again"**, **"Repeat the question"**  
Claude repeats them.

**"Next question"**, **"Another one"**  
Asks the next one, and the score so far shows on the card.

**"Stop the quiz"**, **"No more questions"**  
Ends the trivia and stops the clip (trivia_end), and Claude gives your score.

**Play Music**  
The button beside Start on the card closes these tabs and plays every song's clip in turn. The talk circle shows the song's title, artist and year. Its round arrows, or the left and right arrow keys, go back and forward through the songs, and a tap on the circle pauses and resumes. For each song, Claude picks a mood from its theme for the background colors, and when the song is about weather, water, the sky, a season or a place, it shows the Earth map there instead.

**Pausing the clip**  
The voice widget's play-pause button pauses the clip along with Claude's voice, and resumes both.

## Adding Trivia

Any set of multiple-choice questions in a CSV file can be asked the same way. `Trivia.add()` in engine/js/trivia.js adds one. It needs a Question column, Possible Answers separated by `|` and a Correct Answer, and an Audio Clip Lookup URL for each clip, which can be an iTunes search, an archive.org item or any audio file. engine/js/talk-circle.js lists the sets that have a tab here (TRIVIA).
