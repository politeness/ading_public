package com.politeness.ading.ops.dal;

import java.time.LocalDateTime;
import lombok.Getter;
import lombok.Setter;

/**
 * The account row checked at ops console login.
 * Only the columns needed for verification and display; the password hash is discarded after use and never goes into any log or response.
 */
@Getter
@Setter
public class OpsAccountRow {

    private String userId;
    private String username;
    private String displayName;
    private Boolean isAgent;
    private String status;
    private String password;
    private Integer tokenEpoch;
    private LocalDateTime registeredAt;
}
