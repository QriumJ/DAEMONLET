"""Bounded stdin reader; only the owner thread touches inference/generators."""
from collections import deque
import json
from threading import Condition, Thread


def read_request(source):
    line = source.readline(65537)
    if not line:
        raise EOFError()
    if len(line) > 65536 or not line.endswith('\n'):
        raise ValueError('PROTOCOL_LIMIT')
    value = json.loads(line)
    if not isinstance(value, dict) or value.get('protocolVersion') != 1 or not isinstance(value.get('requestId'), str):
        raise ValueError('PROTOCOL_VERSION')
    return value


class Inbox:
    def __init__(self, source):
        self.items = deque()
        self.condition = Condition()
        self.closed = False
        self.thread = Thread(target=self._read, args=(source,), daemon=True)
        self.thread.start()

    def _read(self, source):
        while True:
            try:
                value = read_request(source)
            except Exception as error:
                value = error
            with self.condition:
                self.condition.wait_for(lambda: self.closed or len(self.items) < 32)
                if self.closed:
                    return
                self.items.append(value)
                self.condition.notify_all()
            if isinstance(value, Exception):
                return

    def peek(self, wait=False):
        with self.condition:
            if wait:
                self.condition.wait_for(lambda: self.closed or self.items)
            if not self.items:
                return None
            value = self.items[0]
            if isinstance(value, Exception):
                raise value
            return value

    def take(self):
        value = self.peek(True)
        with self.condition:
            self.items.popleft()
            self.condition.notify_all()
        return value

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()


def stream_target(request):
    binding = request.get('binding', {})
    return dict(requestId=request['requestId'], synthesisId=request.get('synthesisId'),
                runtimeSessionId=binding.get('runtimeSessionId'), speechEpoch=binding.get('speechEpoch'))


class StreamCancelled(Exception):
    def __init__(self, request, boundary):
        self.request = request
        self.boundary = boundary


class StreamControl:
    def __init__(self, inbox, request, consume_tail):
        self.inbox, self.target, self.consume_tail = inbox, stream_target(request), consume_tail
        self.received = 0

    def checkpoint(self, produced, boundary='chunk-boundary'):
        while (value := self.inbox.peek()) is not None:
            if value['type'] == 'cancel-stream':
                if value.get('target') != self.target:
                    raise ValueError('STREAM_CANCEL_BINDING')
                raise StreamCancelled(self.inbox.take(), boundary)
            if value['type'] != 'credit':
                return
            if self.consume_tail(value):
                self.inbox.take()
                continue
            if value != dict(protocolVersion=1, type='credit', requestId=self.target['requestId'], chunkIndex=self.received):
                raise ValueError('STREAM_CREDIT')
            if self.received >= produced:
                return
            self.inbox.take()
            self.received += 1

    def __call__(self, produced):
        self.checkpoint(produced)
        while produced >= 3 and self.received <= produced - 3:
            value = self.inbox.peek(True)
            if value['type'] not in ('credit', 'cancel-stream'):
                raise ValueError('STREAM_CREDIT')
            self.checkpoint(produced, 'credit-wait')
