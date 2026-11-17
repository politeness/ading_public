package com.politeness.ading.conductor.manager;

import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;

class TurnActivityBoardExpiryTest {
    @Test void snapshotsExpireWithoutBusyReReportsAndEndOnBusyFalse() {
        AtomicLong now = new AtomicLong(1000);
        var board = new TurnActivityBoard(now::get);
        board.record("owner", "task", "agent", true, "first");
        now.addAndGet(20000);
        board.record("owner", "task", "agent", true, "");
        now.addAndGet(20000);
        assertEquals(List.of("first"), board.linesOf(board.activeFor("owner").getFirst()));
        now.addAndGet(10000);
        assertTrue(board.activeFor("owner").isEmpty());
        board.record("owner", "task", "agent", true, "");
        board.record("owner", "task", "agent", false, "");
        assertTrue(board.activeFor("owner").isEmpty());
    }
}
