import React, { useEffect, useState } from "react";
import { AppState, ScrollView, useColorScheme, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import type { Session } from "@supabase/supabase-js";
import { client, configurationError, messageOf } from "./src/client";
import {
  Button,
  Card,
  ErrorBox,
  Field,
  Heading,
  Label,
  Loading,
  palettes,
  styles,
  Theme,
} from "./src/ui";
import Home from "./src/Home";

export default function App() {
  const systemTheme = useColorScheme();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");
  const configError = configurationError();
  useEffect(() => {
    if (!client) {
      setReady(true);
      return;
    }
    let active = true;
    void client.auth
      .getSession()
      .then(({ data, error: failure }) => {
        if (active) {
          setSession(data.session);
          setError(failure?.message || "");
          setReady(true);
        }
      })
      .catch((failure) => {
        if (active) {
          setError(messageOf(failure));
          setReady(true);
        }
      });
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      if (active) {
        setSession(next);
        setReady(true);
      }
    });
    const state = AppState.addEventListener("change", (next) => {
      if (next === "active") client!.auth.startAutoRefresh();
      else client!.auth.stopAutoRefresh();
    });
    if (AppState.currentState === "active") client.auth.startAutoRefresh();
    return () => {
      active = false;
      data.subscription.unsubscribe();
      state.remove();
      client!.auth.stopAutoRefresh();
    };
  }, []);
  async function authenticate(signUp: boolean) {
    if (!client || busy) return;
    setBusy(true);
    setError("");
    setInfo("");
    try {
      if (!email.trim() || !password)
        throw new Error("Informe seu e-mail e sua senha.");
      const { data, error: failure } = await (signUp
        ? client.auth.signUp({ email: email.trim(), password })
        : client.auth.signInWithPassword({ email: email.trim(), password }));
      if (failure) throw failure;
      setPassword("");
      if (signUp && !data.session)
        setInfo(
          "Conta solicitada. Confira seu e-mail para confirmar o cadastro e depois entre no Avana.",
        );
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SafeAreaProvider>
      <Theme.Provider
        value={systemTheme === "dark" ? palettes.dark : palettes.light}
      >
        {session && client ? (
          <Home
            key={session.user.id}
            userId={session.user.id}
            email={session.user.email || ""}
          />
        ) : (
          <SafeAreaView
            style={{
              flex: 1,
              backgroundColor:
                systemTheme === "dark" ? palettes.dark.bg : palettes.light.bg,
            }}
          >
            <StatusBar style={systemTheme === "dark" ? "light" : "dark"} />
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={[
                styles.content,
                {
                  flexGrow: 1,
                  justifyContent: "center",
                  maxWidth: 520,
                  width: "100%",
                  alignSelf: "center",
                },
              ]}
            >
              <Heading>Avana</Heading>
              <Label muted>Seu trabalho, com clareza.</Label>
              {configError ? (
                <Card>
                  <Heading>Conecte o Avana</Heading>
                  <Label>{configError}</Label>
                  <Label muted>
                    Use o mesmo projeto Supabase da versão Web. O Android acessa
                    os dados da sua conta e não cria uma base local alternativa.
                    As instruções estão em mobile/README.md.
                  </Label>
                </Card>
              ) : !ready ? (
                <Loading />
              ) : (
                <>
                  <Field
                    label="E-mail"
                    value={email}
                    onChangeText={setEmail}
                    autoCapitalize="none"
                    autoComplete="email"
                    keyboardType="email-address"
                    editable={!busy}
                  />
                  <Field
                    label="Senha"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    autoComplete="current-password"
                    editable={!busy}
                  />
                  {error && <ErrorBox>{error}</ErrorBox>}
                  {info && (
                    <Card>
                      <Label>{info}</Label>
                    </Card>
                  )}
                  <Button
                    primary
                    disabled={busy}
                    onPress={() => void authenticate(false)}
                  >
                    {busy ? "Aguarde…" : "Entrar"}
                  </Button>
                  <Button
                    disabled={busy}
                    onPress={() => void authenticate(true)}
                  >
                    Criar conta
                  </Button>
                  <Label muted>
                    As notificações e automações do Avana ficam dentro do
                    aplicativo. Nenhuma mensagem é enviada a terceiros.
                  </Label>
                </>
              )}
            </ScrollView>
          </SafeAreaView>
        )}
      </Theme.Provider>
    </SafeAreaProvider>
  );
}
