import { AbsoluteFill, Img, Audio, useCurrentFrame, useVideoConfig, interpolate, Sequence } from 'remotion';

export const TikTokVideo = ({ scenes }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ backgroundColor: '#1a1a1a' }}>
      {scenes.map((scene, i) => {
        const startFrame = scenes.slice(0, i).reduce((acc, s) => acc + Math.ceil(s.duration * fps), 0);
        const durationFrames = Math.ceil(scene.duration * fps);

        return (
          <Sequence key={i} from={startFrame} durationInFrames={durationFrames}>
            <SceneComponent scene={scene} fps={fps} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const SceneComponent = ({ scene, fps }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  // Fade in transition
  const opacity = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });

  // Karaoke word highlighting
  const words = (scene.narration || '').split(' ').filter(w => w);
  const totalFrames = Math.ceil(scene.duration * fps);
  const currentWordIdx = Math.floor((frame / totalFrames) * words.length);

  // Split words into lines of 5
  const lines = [];
  for (let i = 0; i < words.length; i += 5) {
    lines.push(words.slice(i, i + 5));
  }

  return (
    <AbsoluteFill style={{ opacity }}>
      {/* Background image */}
      {scene.imageUrl && (
        <Img
          src={scene.imageUrl}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      )}

      {/* Dark gradient overlay */}
      <AbsoluteFill
        style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.05) 35%, rgba(0,0,0,0.05) 55%, rgba(0,0,0,0.75) 100%)',
        }}
      />

      {/* Hook text — top */}
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
          paddingTop: 60,
          paddingLeft: 30,
          paddingRight: 30,
        }}
      >
        <div
          style={{
            color: 'white',
            fontSize: 52,
            fontWeight: 'bold',
            fontFamily: 'Georgia, serif',
            textAlign: 'center',
            lineHeight: 1.2,
            textTransform: scene.template === 'magazine' ? 'uppercase' : 'none',
            textShadow: '0 2px 8px rgba(0,0,0,0.8)',
          }}
        >
          {scene.overlay_text}
        </div>

        {scene.template === 'magazine' && (
          <div style={{
            width: '60%',
            height: 2,
            backgroundColor: '#c9a99a',
            marginTop: 16,
          }} />
        )}
      </AbsoluteFill>

      {/* Karaoke narration — center */}
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          paddingTop: height * 0.1,
          paddingLeft: 30,
          paddingRight: 30,
        }}
      >
        {lines.map((lineWords, lineIdx) => {
          const lineStartWord = lineIdx * 5;
          return (
            <div key={lineIdx} style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              {lineWords.map((word, wi) => {
                const globalIdx = lineStartWord + wi;
                const isCurrentWord = globalIdx === currentWordIdx;
                const isPastWord = globalIdx < currentWordIdx;
                return (
                  <span
                    key={wi}
                    style={{
                      color: isCurrentWord ? '#FFE566' : isPastWord ? 'rgba(255,255,255,0.5)' : 'white',
                      fontSize: isCurrentWord ? 42 : 38,
                      fontFamily: 'Georgia, serif',
                      fontWeight: isCurrentWord ? 'bold' : 'normal',
                      textShadow: '0 2px 6px rgba(0,0,0,0.9)',
                      transition: 'all 0.1s',
                    }}
                  >
                    {word}
                  </span>
                );
              })}
            </div>
          );
        })}
      </AbsoluteFill>

      {/* Audio */}
      {scene.audioUrl && (
        <Audio src={scene.audioUrl} />
      )}

      {/* Branding */}
      <AbsoluteFill
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'flex-end',
          padding: 20,
        }}
      >
        <span style={{
          color: '#c9a99a',
          fontSize: 24,
          fontFamily: 'Georgia, serif',
          fontStyle: 'italic',
        }}>
          angelakim87
        </span>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
