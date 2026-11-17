package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.PositiveOrZero;

public record ReadRequest(@PositiveOrZero long seq) {
}
