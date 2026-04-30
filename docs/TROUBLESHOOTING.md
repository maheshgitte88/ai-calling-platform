# Troubleshooting

## Summary & extraction not generated

### Why it happens

1. **Timeout (5 min)**: The call hit `MAX_CALL_SECONDS` before the user hung up. The agent used to skip summary on timeout; this is now fixed.

2. **User hung up quickly**: When the participant disconnects, the session may close before the summary block runs. The agent now generates summary even on timeout/cancel.

3. **Invalid Gemini API key**: Summary uses Gemini. If `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) in `.env` is wrong, or the client’s Gemini API key in config is invalid, summary fails. The agent now prefers the client’s LLM API key when the provider is Gemini.

4. **MITSDE / per-client keys**: Each client can have its own LLM config. Ensure the client’s Gemini API key is valid in Dashboard → Client → Config → LLM.

### Recovering stuck calls

Calls stuck in "in-progress" with transcripts but no summary can be recovered:

1. **Dashboard**: Open the call → click **Recover summary** (shown when status is in-progress and transcript exists).

2. **CLI**:
   ```bash
   cd agent-python
   python recover_stuck_calls.py              # recover all stuck
   python recover_stuck_calls.py <call_id>    # recover one call
   ```

Ensure `MONGODB_URI` and `GOOGLE_API_KEY` (or client Gemini key) are set.
