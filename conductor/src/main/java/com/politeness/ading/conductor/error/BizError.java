package com.politeness.ading.conductor.error;

/**
 * Shared contract for all business error codes. The global exception handler only recognizes this interface.
 * Convention: codes carry a module prefix, so a client seeing TURN_003 knows which domain the problem came from.
 */
public interface BizError {

    String code();

    String message();
}
