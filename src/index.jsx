import { Composition } from 'remotion';
import { TikTokVideo } from './VideoComposition';

export const RemotionRoot = () => {
  return (
    <Composition
      id="TikTokVideo"
      component={TikTokVideo}
      durationInFrames={150}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{ scenes: [] }}
    />
  );
};
