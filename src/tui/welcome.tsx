import { Box, Text, useApp, useInput } from "ink";
import { SafeText } from "./components.js";

export function Welcome({ root, isGit, onAnswer }: { root: string; isGit: boolean; onAnswer: (create: boolean) => void }) {
  const { exit } = useApp();
  useInput((input) => {
    if (input === "y" || input === "Y") {
      onAnswer(true);
    } else if (input === "n" || input === "N" || input === "q") {
      onAnswer(false);
      exit();
    }
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Welcome to dept</Text>
      <SafeText>{`Folder: ${root}`}</SafeText>
      <Text>{isGit ? "This is a git repository." : "This is not a git repository. Agents can plan here, but code tasks wait until you approve running git init."}</Text>
      <Text> </Text>
      <Text color="yellow" bold>
        Create a dept workspace here? (y/n)
      </Text>
      <Text dimColor>This adds a small .dept marker folder (excluded from git) and stores project state outside the folder.</Text>
    </Box>
  );
}
