package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.error.AuthError;
import com.politeness.ading.conductor.error.CommonError;
import com.politeness.ading.conductor.error.RegionError;
import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.FieldError;
import org.springframework.web.ErrorResponse;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

/**
 * Global exception handling. Only the BizError interface is recognized; each domain's error enum goes out through here.
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Result<Void>> handleBiz(BizException e, HttpServletRequest request) {
        HttpStatus status = statusOf(e);
        if (status.is5xxServerError()) {
            log.error("Business exception {} {}", request.getMethod(), request.getRequestURI(), e);
        } else {
            log.debug("Business exception {} {} -> {}", request.getMethod(), request.getRequestURI(), e.getMessage());
        }
        return ResponseEntity.status(status)
                .body(Result.error(e.getError(), stripPrefix(e.getMessage(), e.getError().code())));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Result<Void>> handleValidation(MethodArgumentNotValidException e) {
        String detail = e.getBindingResult().getFieldErrors().stream()
                .findFirst()
                .map(this::describe)
                .orElse(CommonError.BAD_REQUEST.message());
        return ResponseEntity.badRequest().body(Result.error(CommonError.BAD_REQUEST, detail));
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public ResponseEntity<Result<Void>> handleMissingParam(MissingServletRequestParameterException e) {
        return ResponseEntity.badRequest()
                .body(Result.error(CommonError.BAD_REQUEST, "Missing parameter: " + e.getParameterName()));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Result<Void>> handleIllegalArgument(IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(Result.error(CommonError.BAD_REQUEST, e.getMessage()));
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Result<Void>> handleResponseStatus(ResponseStatusException e) {
        CommonError error = e.getStatusCode().is4xxClientError()
                ? CommonError.BAD_REQUEST
                : CommonError.INTERNAL_ERROR;
        return ResponseEntity.status(e.getStatusCode())
                .body(Result.error(error, e.getReason()));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Result<Void>> handleUnreadable(HttpMessageNotReadableException e) {
        return ResponseEntity.badRequest().body(Result.error(CommonError.BAD_REQUEST, "Malformed request body"));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Result<Void>> handleOther(Exception e, HttpServletRequest request) {
        // 4xx thrown by the framework itself (path not found, method not supported, wrong content type) all implement ErrorResponse,
        // and must return the status code they declare. If everything were turned into 500, probing any non-existent path would log an error,
        // and real server failures would be drowned out.
        if (e instanceof ErrorResponse framework && framework.getStatusCode().is4xxClientError()) {
            HttpStatusCode status = framework.getStatusCode();
            log.debug("Client error {} {} -> {}", request.getMethod(), request.getRequestURI(), status.value());
            return ResponseEntity.status(status).body(clientError(status));
        }
        log.error("Unexpected exception {} {}", request.getMethod(), request.getRequestURI(), e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Result.error(CommonError.INTERNAL_ERROR));
    }

    private Result<Void> clientError(HttpStatusCode status) {
        return switch (status.value()) {
            case 404 -> Result.error(CommonError.NOT_FOUND);
            case 405 -> Result.error(CommonError.BAD_REQUEST, "Request method not supported");
            case 415 -> Result.error(CommonError.BAD_REQUEST, "Unsupported content type");
            default -> Result.error(CommonError.BAD_REQUEST);
        };
    }

    private HttpStatus statusOf(BizException e) {
        String code = e.getError().code();
        if (e.getError() instanceof AuthError) {
            return HttpStatus.UNAUTHORIZED;
        }
        if (e.getError() instanceof RegionError) {
            return HttpStatus.FORBIDDEN;
        }
        if (CommonError.NOT_FOUND.code().equals(code)) {
            return HttpStatus.NOT_FOUND;
        }
        if (CommonError.FORBIDDEN.code().equals(code)) {
            return HttpStatus.FORBIDDEN;
        }
        if (CommonError.INTERNAL_ERROR.code().equals(code)) {
            return HttpStatus.INTERNAL_SERVER_ERROR;
        }
        return HttpStatus.BAD_REQUEST;
    }

    private String describe(FieldError error) {
        return error.getField() + " " + error.getDefaultMessage();
    }

    private String stripPrefix(String message, String code) {
        String prefix = code + ": ";
        return message != null && message.startsWith(prefix) ? message.substring(prefix.length()) : message;
    }
}
