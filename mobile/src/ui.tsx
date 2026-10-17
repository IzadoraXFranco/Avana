import React, { createContext, useContext } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  Linking,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { priorityLabels } from "../../shared/dates";
import type { Priority } from "../../shared/types";

export const palettes = {
  light: {
    bg: "#F6F3FC",
    surface: "#FFFFFF",
    soft: "#EEE5FA",
    text: "#30243E",
    muted: "#70647E",
    border: "#DDD3E8",
    primary: "#7040A0",
    contrast: "#FFFFFF",
    danger: "#B72B42",
    success: "#23764E",
  },
  dark: {
    bg: "#1C1426",
    surface: "#292034",
    soft: "#3D2C50",
    text: "#F4ECFA",
    muted: "#C1B2CF",
    border: "#4C3D5B",
    primary: "#D0A5F5",
    contrast: "#28143A",
    danger: "#FF9EAE",
    success: "#8CD7AD",
  },
};
export type Palette = typeof palettes.light;
export const Theme = createContext<Palette>(palettes.light);
export const useTheme = () => useContext(Theme);
export function Label({
  children,
  muted = false,
  bold = false,
}: {
  children: React.ReactNode;
  muted?: boolean;
  bold?: boolean;
}) {
  const c = useTheme();
  return (
    <Text
      selectable
      style={{
        color: muted ? c.muted : c.text,
        fontSize: 14,
        lineHeight: 21,
        fontWeight: bold ? "600" : "400",
      }}
    >
      {children}
    </Text>
  );
}
export function Heading({ children }: { children: React.ReactNode }) {
  const c = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{ color: c.text, fontWeight: "700", fontSize: 20, lineHeight: 27 }}
    >
      {children}
    </Text>
  );
}
export function Button({
  children,
  onPress,
  disabled,
  primary,
  danger,
  small,
  label,
}: {
  children: React.ReactNode;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  small?: boolean;
  label?: string;
}) {
  const c = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: small ? 10 : 14,
        paddingVertical: 10,
        borderRadius: 10,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: primary ? c.primary : c.soft,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          color: primary ? c.contrast : danger ? c.danger : c.primary,
          fontWeight: "600",
          fontSize: 14,
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}
export function Field({
  label,
  hint,
  ...props
}: TextInputProps & { label: string; hint?: string }) {
  const c = useTheme();
  return (
    <View style={{ gap: 4, flexGrow: 1 }}>
      <Label bold>{label}</Label>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={c.muted}
        {...props}
        style={[
          {
            color: c.text,
            backgroundColor: c.surface,
            borderColor: c.border,
            borderWidth: 1,
            borderRadius: 9,
            paddingHorizontal: 12,
            paddingVertical: 10,
            minHeight: 46,
            fontSize: 16,
            textAlignVertical: props.multiline ? "top" : "center",
          },
          props.style,
        ]}
      />
      {hint && <Label muted>{hint}</Label>}
    </View>
  );
}
export function Row({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
      }}
    >
      {children}
    </View>
  );
}
export function Card({ children }: { children: React.ReactNode }) {
  const c = useTheme();
  return (
    <View
      style={{
        backgroundColor: c.surface,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: 14,
        gap: 10,
      }}
    >
      {children}
    </View>
  );
}
export function Divider() {
  const c = useTheme();
  return (
    <View style={{ height: 1, backgroundColor: c.border, marginVertical: 4 }} />
  );
}
export function ErrorBox({ children }: { children: React.ReactNode }) {
  const c = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={{
        padding: 12,
        borderWidth: 1,
        borderColor: c.danger,
        borderRadius: 10,
        gap: 8,
      }}
    >
      {React.Children.map(children, (child) =>
        typeof child === "string" || typeof child === "number" ? (
          <Text selectable style={{ color: c.danger, lineHeight: 21 }}>
            {child}
          </Text>
        ) : (
          child
        ),
      )}
    </View>
  );
}
export function Loading() {
  const c = useTheme();
  return (
    <View style={{ padding: 24 }}>
      <ActivityIndicator color={c.primary} />
    </View>
  );
}
export function Sheet({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const c = useTheme();
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View
            style={{
              padding: 16,
              gap: 12,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              borderBottomWidth: 1,
              borderColor: c.border,
            }}
          >
            <View style={{ flex: 1 }}>
              <Heading>{title}</Heading>
            </View>
            <Button onPress={onClose} label={`Fechar ${title}`}>
              Fechar
            </Button>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}
          >
            {children}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
export function Choices<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const c = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Label bold>{label}</Label>
      <Row>
        {options.map((option) => (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{
              selected: value === option.value,
              disabled: !!disabled,
            }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={{
              minHeight: 44,
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderWidth: 1,
              borderRadius: 10,
              borderColor: value === option.value ? c.primary : c.border,
              backgroundColor: value === option.value ? c.soft : c.surface,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <Text
              style={{
                color: value === option.value ? c.primary : c.text,
                fontWeight: value === option.value ? "600" : "400",
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </Row>
    </View>
  );
}
export function PriorityChoices({
  value,
  onChange,
  disabled,
}: {
  value: Priority;
  onChange: (value: Priority) => void;
  disabled?: boolean;
}) {
  const c = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Label bold>Prioridade</Label>
      <Row>
        {(["", "high", "medium", "low"] as Priority[]).map((p) => (
          <Pressable
            key={p || "none"}
            accessibilityRole="radio"
            accessibilityState={{ selected: p === value, disabled: !!disabled }}
            disabled={disabled}
            onPress={() => onChange(p)}
            style={{
              minHeight: 44,
              padding: 10,
              borderWidth: 1,
              borderRadius: 9,
              borderColor: p === value ? c.primary : c.border,
              backgroundColor: p === value ? c.soft : c.surface,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
            }}
          >
            <PriorityDot priority={p} />
            <Text style={{ color: c.text }}>{priorityLabels[p]}</Text>
          </Pressable>
        ))}
      </Row>
    </View>
  );
}
export function PriorityDot({ priority }: { priority: Priority }) {
  const c = useTheme();
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor:
          priority === "high"
            ? "#E35167"
            : priority === "medium"
              ? "#D6A322"
              : priority === "low"
                ? "#4B8ED8"
                : c.muted,
      }}
    />
  );
}
export function LinkedText({ text }: { text: string }) {
  const c = useTheme();
  return (
    <Text selectable style={{ color: c.text, fontSize: 14, lineHeight: 22 }}>
      {text.split(/(https?:\/\/[^\s]+)/g).map((part, index) =>
        /^https?:\/\//.test(part) ? (
          <Text
            key={index}
            accessibilityRole="link"
            onPress={() => {
              void Linking.openURL(part).catch(() => undefined);
            }}
            style={{ color: c.primary, textDecorationLine: "underline" }}
          >
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}
export const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { padding: 16, gap: 14, paddingBottom: 36 },
});
export function validDate(value: string) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
