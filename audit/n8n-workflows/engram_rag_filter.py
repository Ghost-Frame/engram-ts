"""
title: Engram RAG Filter
description: Injects Engram memory context into every conversation before LLM processing, and stores exchanges back into Engram after each response.
author: zan
version: 1.1.0
requirements: aiohttp
"""

from pydantic import BaseModel, Field
from typing import Optional
import aiohttp
import json
import time


class Pipeline:
    class Valves(BaseModel):
        engram_url: str = Field(
            default="http://127.0.0.1:4200",
            description="Engram API base URL",
        )
        engram_api_key: str = Field(
            default="",
            description="Engram API key (eg_...)",
        )
        context_budget: int = Field(
            default=3000,
            description="Max token budget for injected context",
        )
        search_limit: int = Field(
            default=8,
            description="Max memories to retrieve per query",
        )
        min_score: float = Field(
            default=0.3,
            description="Minimum relevance score to include a memory",
        )
        enabled: bool = Field(
            default=True,
            description="Enable/disable Engram context injection",
        )
        source_tag: str = Field(
            default="open-webui",
            description="Source tag for stored memories",
        )
        store_conversations: bool = Field(
            default=True,
            description="Store conversation exchanges back into Engram",
        )
        min_exchange_length: int = Field(
            default=20,
            description="Minimum user message length to trigger storage",
        )

    def __init__(self):
        self.valves = self.Valves()

    async def inlet(self, body: dict, __user__: dict) -> dict:
        """
        Before LLM: fetch relevant context from Engram and inject into system message.
        """
        if not self.valves.enabled or not self.valves.engram_api_key:
            return body

        messages = body.get("messages", [])
        if not messages:
            return body

        # Get the latest user message as the query
        user_messages = [m for m in messages if m.get("role") == "user"]
        if not user_messages:
            return body

        query = user_messages[-1].get("content", "").strip()
        if not query or len(query) < 3:
            return body

        # Call Engram /context for budget-aware retrieval
        try:
            context_text = await self._fetch_context(query)
        except Exception:
            # Engram is down or unreachable -- don't block the conversation
            return body

        if not context_text:
            return body

        # Inject context into system message
        context_block = (
            "You have access to the user's memory system. "
            "The following relevant memories were retrieved:\n\n"
            f"{context_text}\n\n"
            "Use these memories to inform your response when relevant. "
            "Do not mention the memory system unless the user asks about it."
        )

        # Find existing system message or create one
        system_idx = None
        for i, m in enumerate(messages):
            if m.get("role") == "system":
                system_idx = i
                break

        if system_idx is not None:
            messages[system_idx]["content"] = (
                messages[system_idx]["content"] + "\n\n" + context_block
            )
        else:
            messages.insert(0, {"role": "system", "content": context_block})

        body["messages"] = messages
        return body

    async def outlet(self, body: dict, __user__: dict) -> dict:
        """
        After LLM: store the conversation exchange in Engram.
        Only stores if the response is substantial (not just greetings/errors).
        """
        if not self.valves.enabled or not self.valves.engram_api_key:
            return body

        if not self.valves.store_conversations:
            return body

        messages = body.get("messages", [])
        if len(messages) < 2:
            return body

        # Get the last user message and assistant response
        user_msg = None
        assistant_msg = None
        for m in reversed(messages):
            if m.get("role") == "assistant" and assistant_msg is None:
                assistant_msg = m.get("content", "")
            elif m.get("role") == "user" and user_msg is None:
                user_msg = m.get("content", "")
            if user_msg and assistant_msg:
                break

        if not user_msg or not assistant_msg:
            return body

        # Skip trivial exchanges
        if len(user_msg) < self.valves.min_exchange_length and len(assistant_msg) < 50:
            return body

        # Build a condensed exchange to store
        exchange = f"User asked: {user_msg}\nAssistant answered: {assistant_msg[:500]}"

        try:
            await self._store_memory(exchange)
        except Exception:
            pass  # Don't break the response if storage fails

        # Also store full conversation
        model = body.get("model", "unknown")
        try:
            await self._store_conversation(messages, model)
        except Exception:
            pass

        return body

    async def _fetch_context(self, query: str) -> str:
        """Call Engram /context endpoint for budget-aware retrieval."""
        headers = {
            "Authorization": f"Bearer {self.valves.engram_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "query": query,
            "budget": self.valves.context_budget,
        }

        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{self.valves.engram_url}/context",
                json=payload,
                headers=headers,
            ) as resp:
                if resp.status != 200:
                    return ""
                data = await resp.json()

        # Format context from response
        memories = data.get("memories", data.get("results", []))
        if not memories:
            return data.get("context", "")

        lines = []
        for mem in memories:
            content = mem.get("content", "")
            category = mem.get("category", "")
            score = mem.get("score", 0)
            if score < self.valves.min_score:
                continue
            created = mem.get("created_at", "")[:10]
            lines.append(f"- [{category}] ({created}) {content}")

        return "\n".join(lines[: self.valves.search_limit])

    async def _store_memory(self, content: str) -> None:
        """Store a conversation exchange in Engram."""
        headers = {
            "Authorization": f"Bearer {self.valves.engram_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "content": content,
            "category": "conversation",
            "source": self.valves.source_tag,
            "importance": 4,
            "tags": ["open-webui", "chat"],
        }

        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{self.valves.engram_url}/store",
                json=payload,
                headers=headers,
            ) as resp:
                pass  # Fire and forget

    async def _store_conversation(self, messages: list, model: str) -> None:
        """Store full conversation in Engram's conversation tracking."""
        headers = {
            "Authorization": f"Bearer {self.valves.engram_api_key}",
            "Content-Type": "application/json",
        }

        # Filter to just user/assistant messages (no system)
        conv_messages = [
            {"role": m["role"], "content": m.get("content", "")}
            for m in messages
            if m.get("role") in ("user", "assistant")
        ]

        if len(conv_messages) < 2:
            return

        payload = {
            "agent": f"open-webui/{model}",
            "title": conv_messages[0]["content"][:100] if conv_messages else "Chat",
            "messages": conv_messages,
        }

        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{self.valves.engram_url}/conversations",
                json=payload,
                headers=headers,
            ) as resp:
                pass
