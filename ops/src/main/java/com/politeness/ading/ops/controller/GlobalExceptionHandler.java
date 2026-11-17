package com.politeness.ading.ops.controller;

import com.politeness.ading.ops.common.BizException;
import com.politeness.ading.ops.common.OpsError;
import com.politeness.ading.ops.common.Result;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.TypeMismatchException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * Unified error responses.
 *
 * Not-logged-in must be a real HTTP 401, which the frontend uses to switch back to the login view; other business failures return 200 with an error code.
 * Server exceptions keep details only in the log; the browser always gets a generic message, never stack traces or SQL.
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Result<Void>> biz(BizException e) {
        OpsError error = e.error();
        return ResponseEntity.status(error.status()).body(Result.error(error));
    }

    /** Requests like ?page=abc with wrong types or missing parameters are also client problems and must not fall into the catch-all 500 and log an ERROR stack */
    @ExceptionHandler({MethodArgumentNotValidException.class, HandlerMethodValidationException.class,
            HttpMessageNotReadableException.class, TypeMismatchException.class,
            MissingServletRequestParameterException.class})
    public ResponseEntity<Result<Void>> badRequest(Exception e) {
        log.debug("Invalid request parameters: {}", e.getMessage());
        return ResponseEntity.status(OpsError.BAD_REQUEST.status()).body(Result.error(OpsError.BAD_REQUEST));
    }

    /**
     * Wrong method or wrong content type are client problems, not server faults.
     * They map to 405 / 415 instead of the catch-all 500; otherwise the error log fills with scanner noise
     * and real faults get buried.
     */
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<Result<Void>> methodNotAllowed(HttpRequestMethodNotSupportedException e) {
        log.debug("Request method not supported: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED).body(Result.error(OpsError.BAD_REQUEST));
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<Result<Void>> unsupportedMediaType(HttpMediaTypeNotSupportedException e) {
        log.debug("Request content type not supported: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).body(Result.error(OpsError.BAD_REQUEST));
    }

    @ExceptionHandler({NoHandlerFoundException.class, NoResourceFoundException.class})
    public ResponseEntity<Result<Void>> notFound(Exception e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Result.error(OpsError.BAD_REQUEST));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Result<Void>> unexpected(Exception e) {
        log.error("Ops console endpoint exception", e);
        return ResponseEntity.status(OpsError.INTERNAL.status()).body(Result.error(OpsError.INTERNAL));
    }
}
