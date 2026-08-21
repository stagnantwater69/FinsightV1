import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, TextInput } from "react-native";
import { Button, Card, ErrorNote, Field, Screen, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { api, errorMessage } from "../../lib/api";
import { setFlash } from "../../lib/flash";
import { DateField } from "../../components/DateField";
import * as haptics from "../../lib/haptics";
import { space } from "../../theme/tokens";
import { FIELD_LIMITS } from "../../lib/fieldLimits";
import { CategoryPicker, todayISO } from "./shared";

export function AddExpenseScreen({ navigation }: any) {
  const { selected, categories, refreshCategories } = useBusinessProfiles();
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * The category picker and the date field are pressables, not text inputs —
   * they cannot carry a return key at all. So the keyboard chain starts at the
   * first field that actually has one and runs to the end of the form.
   */
  const vendorRef = useRef<TextInput>(null);
  const amountRef = useRef<TextInput>(null);

  if (!selected) return null;

  async function submit() {
    if (!categoryId) return setError("Choose a category first.");
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    setError(null);
    setBusy(true);
    try {
      await api.post("/records/expenses", {
        businessProfileId: selected!.id,
        categoryId,
        date,
        description: description.trim(),
        vendor: vendor.trim() || undefined,
        amount: value,
      });
      haptics.succeeded();
      // The haptic is silent for anyone who has haptics off; the flash is what
      // the owner actually sees once the list comes back.
      setFlash("Expense saved.");
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      {/*
        Amount is the last field on the card and the keyboard is tall, so
        without this it opens straight over the field being typed into. Same
        shell AuthShell uses: `padding` on iOS, nothing on Android, where the
        system already resizes the window.
      */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
          <Card>
            <T variant="title" style={{ marginBottom: space.md }}>Add expense</T>
            <CategoryPicker
              categories={categories}
              value={categoryId}
              onChange={setCategoryId}
              onCreated={refreshCategories}
            />
            <DateField label="Date" value={date} onChange={setDate} />
            {/*
              `submitBehavior="submit"` keeps the keyboard up between fields so
              it does not flicker shut and open on every hop. It is the
              replacement for the prop React Native 0.86 deprecated; see the
              same note on the login form in AuthScreens.
            */}
            <Field
              label="Description"
              value={description}
              maxLength={FIELD_LIMITS.recordDescription}
              onChangeText={setDescription}
              placeholder="e.g. Rice sacks"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => vendorRef.current?.focus()}
            />
            <Field
              ref={vendorRef}
              label="Vendor (optional)"
              value={vendor}
              onChangeText={setVendor}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => amountRef.current?.focus()}
            />
            {/*
              A decimal keypad has no return key on iOS, so this hand-off only
              fires on Android. Wired anyway: it costs nothing where it does
              not apply, and the Save button is the reliable path on both.
            */}
            <Field
              ref={amountRef}
              label="Amount (PHP)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              returnKeyType="done"
              // Mirrors the button's own `loading` guard, so a return key
              // pressed twice cannot post the expense twice.
              onSubmitEditing={() => {
                if (!busy) submit();
              }}
            />
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button title="Save expense" variant="primary" onPress={submit} loading={busy} style={{ marginTop: space.md }} />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
