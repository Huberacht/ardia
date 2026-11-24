import type { Ref } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import { usePageBusy } from "../../state/page/hooks";
import { chromeInk, Favicon, floatingBarLayout, Symbol, usePressStyle } from "../ui";
import { privateMark } from "../ui/IncognitoSpecs";
import { spokenAddress, type BarAddress } from "./FloatingBar";
import { NotSecureLock } from "./NotSecureLock";

type Props = { address: BarAddress | null; dark: boolean; testIDPrefix: string; style: StyleProp<ViewStyle>; onPress: () => void; onPressIn?: () => void; pressRef?: Ref<ViewInstance> };

export function AddressFace({ address, dark, testIDPrefix, style, onPress, onPressIn, pressRef }: Props) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  const pressStyle = usePressStyle("text", { style });
  const busy = usePageBusy(address?.tabId ?? null);
  return (
    <Pressable ref={pressRef} accessibilityRole="button" accessibilityLabel="Address" accessibilityValue={{ text: spokenAddress(address) }} accessibilityState={{ busy }} accessibilityHint="Opens search with this page’s address." onPress={onPress} onPressIn={onPressIn} style={pressStyle}>
      {address?.isPrivate ? <Symbol name={privateMark} size={floatingBarLayout.privateSymbol} color={ink.secondary} /> : null}
      {address?.insecure ? (
        <NotSecureLock testID={`${testIDPrefix}NotSecure`} size={floatingBarLayout.siteIcon} color={ink.notSecure} />
      ) : address?.isPrivate ? null : address?.pageUrl ? (
        <Favicon iconUrl={address.iconUrl} pageUrl={address.pageUrl} size={floatingBarLayout.siteIcon} />
      ) : null}
      <Text testID={`${testIDPrefix}Host`} maxFontSizeMultiplier={floatingBarLayout.maxTextScale} numberOfLines={1} ellipsizeMode="middle" style={[styles.host, { color: ink.foreground }]}>
        {address?.host ?? ""}
      </Text>
    </Pressable>
  );
}

export function AddressLeaf({ address, dark, testIDPrefix, style }: { address: Props["address"]; dark: boolean; testIDPrefix: string; style?: Props["style"] }) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  return (
    <View style={[styles.leaf, style]} pointerEvents="none">
      {address?.isPrivate ? <Symbol name={privateMark} size={floatingBarLayout.privateSymbol} color={ink.secondary} /> : null}
      {address?.insecure ? (
        <NotSecureLock testID={`${testIDPrefix}NotSecure`} size={floatingBarLayout.siteIcon} color={ink.notSecure} />
      ) : address?.isPrivate ? null : address?.pageUrl ? (
        <Favicon iconUrl={address.iconUrl} pageUrl={address.pageUrl} size={floatingBarLayout.siteIcon} />
      ) : null}
      <Text testID={`${testIDPrefix}Host`} maxFontSizeMultiplier={floatingBarLayout.maxTextScale} numberOfLines={1} ellipsizeMode="middle" style={[styles.host, { color: ink.foreground }]}>
        {address?.host ?? ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  leaf: { flexDirection: "row", alignItems: "center" },
  host: { flexShrink: 1, fontSize: floatingBarLayout.hostText },
});
