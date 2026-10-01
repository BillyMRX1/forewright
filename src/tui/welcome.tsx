import { Box, Text, useApp, useInput } from "ink";
import { SafeText } from "./components.js";
import { borderStyle, palette } from "./theme.js";

export function Welcome({ root, isGit, onAnswer }: { root: string; isGit: boolean; onAnswer: (create: boolean) => void }) {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === "y" || input === "Y") {
      onAnswer(true);
    } else if (input === "n" || input === "N" || input === "q" || key.escape || (key.ctrl && input === "c")) {
      onAnswer(false);
      exit();
    }
  });
  return (
    <Box borderStyle={borderStyle()} borderColor={palette.accent} flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Welcome to Forewright</Text>
      <SafeText dimColor>{`Folder: ${root}`}</SafeText>
      <Text> </Text>
      <Text>{isGit ? "This is a git repository." : "This is not a git repository. Agents can plan here, but code tasks wait until you approve running git init."}</Text>
      <Text> </Text>
      <Text color={palette.attention} bold>
        Create a Forewright workspace here? (y/n)
      </Text>
      <Text dimColor>This adds a small .forewright marker folder (excluded from git) and stores project state outside the folder.</Text>
    </Box>
  );
}
