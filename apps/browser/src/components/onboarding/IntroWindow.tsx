import { View } from "react-native";
import { Intro } from "./Intro";
import { closeIntroWindow, handOffFromIntro } from "./introCover";

export function IntroWindow() {
  return (
    <View style={{ flex: 1 }}>
      <Intro overlay onExitStart={handOffFromIntro} onDone={closeIntroWindow} />
    </View>
  );
}
